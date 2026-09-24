export const records = [
  { id: "S1", region: "north", cents: 120000, status: "paid" },
  { id: "S2", region: "south", cents: 80000, status: "paid" },
  { id: "S3", region: "north", cents: 40000, status: "paid" },
  { id: "S4", region: "south", cents: 50000, status: "cancelled" },
];
export const expectedRows = [
  { region: "north", totalCents: 160000 },
  { region: "south", totalCents: 80000 },
];
export const csv =
  "id,region,cents,status\n" +
  records.map((x) => `${x.id},${x.region},${x.cents},${x.status}`).join("\n") +
  "\n";
export const tests = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discount } from ${JSON.stringify("./discount.mjs")};
for (const [amount, bps, expected] of [[10000,1000,9000],[1999,1250,1749],[10001,3333,6668],[0,5000,0],[12500,0,12500],[4200,10000,0]]) {
  test('discount '+amount+' at '+bps+' bps',()=>assert.equal(discount(amount,bps),expected));
}
`;
export const workflow = `import {readFileSync} from 'node:fs';
const config=JSON.parse(readFileSync('config.json','utf8'));
const [header,...lines]=readFileSync('orders.csv','utf8').trim().split('\\n');
const columns=header.split(config.delimiter);
for (const name of ['region',config.amountColumn,'status']) if(!columns.includes(name)) throw new Error('Missing column: '+name+'; parsed columns: '+columns.join('|'));
const totals={};
for(const line of lines){const row=Object.fromEntries(line.split(config.delimiter).map((v,i)=>[columns[i],v])); if(config.statusFilter!=='all' && row.status!==config.statusFilter)continue; const amount=Number(row[config.amountColumn]);if(!Number.isSafeInteger(amount))throw new Error('Invalid cents');totals[row.region]=(totals[row.region]||0)+amount;}
console.log(JSON.stringify(Object.keys(totals).sort().map(region=>({region,totalCents:totals[region]}))));
`;
export const contract = {
  code: "Return payable integer cents: round(amountCents * (1 - discountBps / 10000)); rounding occurs once on the final payable amount. Inputs are valid nonnegative integer cents and integer bps in [0,10000]. Edit only the arithmetic return expression. Tokens: amountCents, discountBps, numbers, + - * / parentheses, Math.round/floor/ceil. Preserve trusted test files and function wrapper.",
  sql: "Return paid order total cents by region sorted ascending. SQLite table orders(id TEXT, region TEXT, cents INTEGER, status TEXT). Allowed SQL shape: SELECT region, SUM(cents or amount_cents) AS totalCents FROM orders [WHERE status = 'paid' or 'cancelled'] GROUP BY region ORDER BY region. Correct column is cents. No writes, joins, comments or extra statements.",
  config:
    'Process the supplied comma-separated orders.csv and sum only paid orders by region. Edit only JSON {"delimiter":",","amountColumn":"cents","statusFilter":"paid"}. Allowed delimiter: comma/semicolon/tab, amountColumn: cents/amount_cents, statusFilter: paid/cancelled/all. The executable workflow and data are immutable.',
};
