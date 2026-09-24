import csv,json,sqlite3,sys
from pathlib import Path
root=Path(sys.argv[1]);rows=list(csv.DictReader((root/'sales.csv').open(encoding='utf-8-sig',newline=''),strict=True))
if not rows or len(rows)>256:raise ValueError('Expected 1-256 CSV records')
if set(rows[0])!={'orderId','date','region','quantity','unitCents','status'}:raise ValueError('Unexpected CSV fields')
if any(any(v is None for v in row.values()) or None in row for row in rows):raise ValueError('Malformed CSV record')
db=sqlite3.connect((root/'business.sqlite').resolve().as_uri()+'?mode=ro&immutable=1',uri=True)
try:
 schema=db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='sales'").fetchone()
 if not schema:raise ValueError('Missing sales table')
 print(json.dumps({'rows':rows,'schema':schema[0]}))
finally:db.close()
