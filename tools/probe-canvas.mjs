import { handleQuestCanvas } from "../lib/host/quest-api.js";
const dir = "D:\\Desktop\\VibeCoding\\dsh-minecraft-modpack-studio\\lab\\重度机械症 - 实验\\versions\\最小包";
const url = `http://x/api/mcstudio/quest/canvas?dir=${encodeURIComponent(dir)}&locale=en_us`;
const r = await handleQuestCanvas({ url, method: "GET" });
console.log("章数", r.chapterCount, "任务数", r.questCount);
for (const c of r.chapters) {
  console.log(" 章:", c.title, "节点", c.nodes.length, "bounds", JSON.stringify(c.bounds));
  for (const n of c.nodes.slice(0, 6)) {
    console.log("   -", n.id, n.title, `(${n.x},${n.y})`, "deps", n.dependencies.map(d=>d.id).join(",") || "无");
  }
}
