"""Reproduce the supplied WOFF2 without subsetting or changing font metadata.

Requires fonttools[woff] 4.66.1, as recorded in UPSTREAM.json.
Run in this directory: python build-woff2.py
"""
import hashlib
import json
from pathlib import Path
from fontTools.ttLib import TTFont, woff2

base = Path(__file__).resolve().parent
source = base / 'LiberationSans-Regular.ttf'
destination = base / 'LiberationSans-Regular.woff2'
woff2.compress(source, destination, transform_tables=[])
left, right = TTFont(source, lazy=True), TTFont(destination, lazy=True)
assert set(left.reader.keys()) == set(right.reader.keys())
for tag in left.reader.keys():
    a, b = left.reader[tag], right.reader[tag]
    if tag == 'head':
        # The SFNT checksum and WOFF2-required flags bit 11 describe compression.
        a, b = a[:8] + b'\0' * 4 + a[12:], b[:8] + b'\0' * 4 + b[12:]
        a = a[:16] + (int.from_bytes(a[16:18], 'big') & ~(1 << 11)).to_bytes(2, 'big') + a[18:]
        b = b[:16] + (int.from_bytes(b[16:18], 'big') & ~(1 << 11)).to_bytes(2, 'big') + b[18:]
    assert a == b, f'Unexpected font data change in {tag}'
record = json.loads((base / 'UPSTREAM.json').read_text(encoding='utf8'))
assert hashlib.sha256(destination.read_bytes()).hexdigest() == record['files'][destination.name]
print('Verified unchanged font tables, metadata and expected WOFF2 SHA256.')
