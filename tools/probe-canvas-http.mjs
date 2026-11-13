import { registerStudioApi } from "../lib/host/api.js";

const routes = new Map();
registerStudioApi({ fetch: { register(def) { routes.set(def.path, def); } } });

const dir = "D:\\Desktop\\VibeCoding\\dsh-minecraft-modpack-studio\\lab\\重度机械症 - 实验\\versions\\最小包";

async function call(path, query, body) {
  const def = routes.get("/api/mcstudio" + path);
  if (!def) throw new Error("没有这条路由：" + path);
  const url = `http://127.0.0.1/api/mcstudio${path}?${new URLSearchParams(query ?? {}).toString()}`;
  const res = await def.fetch({
    url, method: body ? "POST" : "GET",
    text: async () => (body ? JSON.stringify(body) : ""),
  });
  return res.json();
}

const canvas = await call("/quest/canvas", { dir, locale: "en_us" });
console.log("canvas ok =", canvas.ok, "｜章", canvas.chapterCount, "｜任务", canvas.questCount);
for (const c of canvas.chapters) {
  for (const n of c.nodes) {
    console.log("  ", n.title, `(${n.x},${n.y})`, "依赖:", n.dependencies.map((d) => d.title).join(",") || "无");
  }
}

const first = canvas.chapters[0].nodes[0];
const moves = JSON.stringify([{ questId: first.id, x: first.x, y: first.y + 0.5 }]);
const pv = await call("/quest/move/preview", { dir, locale: "en_us" }, { moves });
console.log("\npreview ok =", pv.ok, "｜要改", pv.changedCount, "个");
console.log((pv.diff ?? []).join("\n"));
console.log("会写进:", (pv.files ?? []).map((f) => f.name).join(","));
