"""Certificate-based digital signatures (PAdES via pyHanko) and signature verification.

The user's PKCS#12 file and its password are only used inside the job's temporary
directory for the duration of the request and are deleted with it."""
from __future__ import annotations

import datetime as _dt

from .base import Context, UserError, op
from .geom import geometry


def _load_signer(path: str, password: str):
    from pyhanko.sign import signers

    try:
        signer = signers.SimpleSigner.load_pkcs12(pfx_file=path, passphrase=password.encode() if password else None)
    except Exception:  # noqa: BLE001 – wrong password / not a PKCS#12 file
        signer = None
    if signer is None:
        raise UserError("bad_certificate")
    return signer


@op("sign_certificate")
def sign_certificate(ctx: Context) -> None:
    from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
    from pyhanko.sign import fields, signers
    from pyhanko.sign.fields import SigFieldSpec

    f = ctx.first_pdf()
    pdf = ctx.open_pdf(f)  # validates password + permissions
    certs = [i for i in ctx.inputs if i is not f]
    if not certs:
        raise UserError("certificate_required")
    signer = _load_signer(certs[0].path, str(ctx.p("cert_password") or ""))
    field_name = str(ctx.p("field_name") or "").strip()
    existing = set()
    acro = pdf.Root.get("/AcroForm")
    if acro is not None:
        for fl in acro.get("/Fields", []):
            if str(fl.get("/FT", "")) == "/Sig":
                existing.add(str(fl.get("/T", "")))
    new_box = None
    if not field_name or field_name not in existing:
        field_name = field_name or f"Signature{len(existing) + 1}"
        if ctx.p("visible", True):
            pi = ctx.pint("page", 0, 0, len(pdf.pages) - 1)
            r = ctx.p("rect") or [40, 40, 200, 60]
            g = geometry(pdf.pages[pi])
            x0, y0, x1, y1 = g.rect_tl_to_user(float(r[0]), float(r[1]), float(r[2]), float(r[3]))
            new_box = (pi, (int(x0), int(y0), int(x1), int(y1)))
    pdf.close()
    pw = ctx.password_for(ctx.inputs.index(f))
    out = ctx.out_path(f.stem + "_signed.pdf")

    def do_sign(box) -> None:
        from pyhanko.stamp import TextStampStyle

        with open(f.path, "rb") as inf:
            w = IncrementalPdfFileWriter(inf, strict=False)
            if w.prev.encrypted:
                w.encrypt(pw)
            if field_name not in existing:
                spec = SigFieldSpec(sig_field_name=field_name, on_page=box[0] if box else 0, box=box[1] if box else None)
                fields.append_signature_field(w, spec)
            meta = signers.PdfSignatureMetadata(
                field_name=field_name, md_algorithm="sha256",
                reason=str(ctx.p("reason") or "")[:200] or None, location=str(ctx.p("location") or "")[:200] or None,
                contact_info=str(ctx.p("contact") or "")[:200] or None,
            )
            # ASCII-only stamp text: the standard stamp font cannot render Arabic names
            style = TextStampStyle(stamp_text="Digitally signed\n%(ts)s", border_width=1)
            with open(out, "wb") as outf:
                signers.PdfSigner(meta, signer=signer, stamp_style=style).sign_pdf(w, output=outf)

    do_sign(new_box)
    # Self-check: the produced signature must be cryptographically intact and valid.
    status = _verify_file(out, pw)
    visible_fallback = False
    if not status.get("valid") and new_box is not None:
        do_sign(None)
        status = _verify_file(out, pw)
        visible_fallback = True
    if not status.get("valid"):
        raise UserError("signing_failed")
    ctx.add_output(out)
    cert = signer.signing_cert
    ctx.result = {"field": field_name, "signer": cert.subject.human_friendly, "issuer": cert.issuer.human_friendly,
                  "valid_until": cert["tbs_certificate"]["validity"]["not_after"].native.isoformat(),
                  "visible_fallback": visible_fallback, "trusted": bool(status.get("trusted"))}


def _verify_file(path: str, password: str = "") -> dict:
    from pyhanko.pdf_utils.reader import PdfFileReader
    from pyhanko.sign.validation import validate_pdf_signature
    from pyhanko_certvalidator import ValidationContext

    try:
        with open(path, "rb") as fh:
            r = PdfFileReader(fh, strict=False)
            if r.encrypted:
                r.decrypt(password)
            sig = r.embedded_signatures[-1]
            st = validate_pdf_signature(sig, ValidationContext(allow_fetching=False))
            return {"intact": st.intact, "valid": st.valid, "trusted": st.trusted}
    except Exception:  # noqa: BLE001
        return {"valid": False}


@op("signatures_verify")
def signatures_verify(ctx: Context) -> None:
    from pyhanko.pdf_utils.reader import PdfFileReader
    from pyhanko.sign.validation import validate_pdf_signature
    from pyhanko_certvalidator import ValidationContext

    f = ctx.first_pdf()
    ctx.open_pdf(f).close()
    out = []
    with open(f.path, "rb") as fh:
        r = PdfFileReader(fh, strict=False)
        if r.encrypted:
            r.decrypt(ctx.password_for(ctx.inputs.index(f)))
        sigs = list(r.embedded_signatures)
        for k, sig in enumerate(sigs[:50]):
            entry = {"field": sig.field_name, "index": k}
            try:
                status = validate_pdf_signature(sig, ValidationContext(allow_fetching=False))
                cert = status.signing_cert
                entry.update({
                    "intact": bool(status.intact), "valid": bool(status.valid), "trusted": bool(status.trusted),
                    "signer": cert.subject.human_friendly if cert else "", "issuer": cert.issuer.human_friendly if cert else "",
                    "signing_time": status.signer_reported_dt.isoformat() if status.signer_reported_dt else None,
                    "coverage": str(status.coverage.name) if status.coverage else None,
                    "modified_after": str(status.modification_level.name) if status.modification_level else None,
                    "md": status.md_algorithm,
                })
            except Exception as e:  # noqa: BLE001
                entry.update({"error": type(e).__name__})
            out.append(entry)
    ctx.result = {"signatures": out, "count": len(out)}


def make_test_certificate(path: str, password: str, name: str = "PDFATY Test") -> None:
    """Self-signed certificate + key as PKCS#12 (used by tests and the demo)."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives.serialization import pkcs12
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)])
    now = _dt.datetime.now(_dt.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - _dt.timedelta(days=1))
            .not_valid_after(now + _dt.timedelta(days=365))
            .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=True, key_encipherment=False,
                                         data_encipherment=False, key_agreement=False, key_cert_sign=False, crl_sign=False,
                                         encipher_only=False, decipher_only=False), critical=True)
            .sign(key, hashes.SHA256()))
    data = pkcs12.serialize_key_and_certificates(name.encode(), key, cert, None,
                                                 serialization.BestAvailableEncryption(password.encode()))
    with open(path, "wb") as fh:
        fh.write(data)



