import { zai } from "../src/lib/zai";
const res = await zai.functions.invoke("web_search", { query: "MiniMax H3 video model", num: 5 }) as unknown as any[];
console.log("results:", res.length);
console.log(res.slice(0,5).map((r) => "- " + r.name.slice(0,60) + " | " + r.host_name).join("\n"));
