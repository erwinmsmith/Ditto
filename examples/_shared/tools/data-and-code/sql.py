"""Read-only, table/column-authorized SQLite query adapter with a VM work budget."""
import json, sqlite3, sys, time
from pathlib import Path
r=json.load(sys.stdin);path=Path(r['path']).resolve();db=sqlite3.connect(path.as_uri()+'?mode=ro&immutable=1',uri=True)
db.execute('PRAGMA query_only=ON');db.enable_load_extension(False);db.row_factory=sqlite3.Row
columns={'orderId','date','region','quantity','unitCents','status'};reads=set()
def authorize(action, first, second, database, trigger):
    if action==sqlite3.SQLITE_SELECT:return sqlite3.SQLITE_OK
    if action==sqlite3.SQLITE_READ and first=='sales' and (second in columns or second==''):
        reads.add(second);return sqlite3.SQLITE_OK
    if action==sqlite3.SQLITE_FUNCTION and second.lower() in {'sum','count','avg','min','max','round','coalesce','abs','lower','upper'}:return sqlite3.SQLITE_OK
    return sqlite3.SQLITE_DENY
started=time.monotonic();ticks=0
def budget():
    global ticks
    ticks+=1
    return int(ticks>2000 or time.monotonic()-started>1)
db.set_authorizer(authorize);db.set_progress_handler(budget,1000)
try:
    cursor=db.execute(r['sql'],r['parameters']);rows=cursor.fetchmany(101)
    if len(rows)>100:raise ValueError('Query exceeds 100 row limit')
    if not reads:raise ValueError('Query must read the authorized sales table')
    print(json.dumps({'rows':[dict(row) for row in rows],'columnsRead':sorted(reads),'readOnly':True,'engine':'SQLite authorizer'}))
finally:db.close()
