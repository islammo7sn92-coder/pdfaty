"""Operation registry. Importing this package registers every operation."""
from .base import REGISTRY, Context, InputFile, UserError  # noqa: F401
from . import pages, stamps, layers, ocr, convert, security, compress, forms, annots, compare, inspect, signing  # noqa: F401
