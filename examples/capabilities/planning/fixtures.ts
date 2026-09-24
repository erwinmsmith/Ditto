import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { catalog, type Mode, type Request } from "../../_shared/tools/planning-domain.ts";
export async function createFixture(directory:string,mode:Mode,change:Partial<Request>={}){
  const marker=randomBytes(4).toString("hex");
  const sales=[{sku:`TEA-${marker}`,daily:[4,7,10]},{sku:`COFFEE-${marker}`,daily:[2,3,4]}];
  const stock=[{sku:sales[0]!.sku,available:8},{sku:sales[1]!.sku,available:50}];
  const request:Request={goal:"根据实际销售和库存资料，生成未来三天的补货建议及本地 JSON、Markdown 报告；不执行采购。",salesFormat:mode==="tools"?"csv":"json",analysis:"best_available",horizonDays:3,budget:{maxModelCalls:2,maxToolCalls:10,maxCostCents:100,maxElapsedMs:300000,concurrency:2,ioSlots:2,cpuSlots:1,memoryUnits:3},allowedTools:catalog.map(t=>t.name),...change};
  await writeFile(join(directory,"request.json"),JSON.stringify(request,null,2));
  await writeFile(join(directory,"sales.json"),JSON.stringify(sales,null,2));
  await writeFile(join(directory,"sales.csv"),"sku,day,quantity\n"+sales.flatMap(row=>row.daily.map((quantity,i)=>`${row.sku},${i+1},${quantity}`)).join("\n")+"\n");
  await writeFile(join(directory,"stock.json"),JSON.stringify(stock,null,2));
  return{request,sales,stock};
}
