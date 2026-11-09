// 실행 중에도 안전하게 DB 사본을 만듭니다.
//   docker compose exec app node server/backup.js
// → /data/backup-YYYY-MM-DD-HHMM.db 생성
import { db } from "./db.js";
import { dirname, join } from "node:path";

const stamp = new Date().toISOString().slice(0, 16).replace("T", "-").replace(":", "");
const out = join(dirname(process.env.DB_FILE || "./data/chat.db"), `backup-${stamp}.db`);
db.exec(`VACUUM INTO '${out.replaceAll("'", "''")}'`);
console.log("백업 완료:", out);
