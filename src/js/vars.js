// ---------- 模板、片段、快速记录里的变量(0.5.1) ----------
// {{日期}} 2026-10-20、{{时间}} 14:05、{{星期}} 星期二、{{日期时间}}(F5 的格式)、
// {{日期:格式}} / {{时间:格式}}(写法同 F5)、{{标题}} 新页面的名字、{{笔记本}}、{{光标}} 光标放在这里。
// 不认识的 {{…}} 原样留着
import { formatDate } from "./datetime.js";

// {{光标}} 先换成这个看不见的字,放进编辑器以后找到它、删掉,把光标放在那里
export const CURSOR = "⁣";

const VAR = /\{\{\s*(日期时间|日期|时间|星期|标题|笔记本|光标)\s*(?:[:：]([^{}]*))?\}\}/g;

// cursor:true 时第一个 {{光标}} 换成 CURSOR,其余的去掉;false 时都去掉
export function fillVars(text, { date = new Date(), dateFormat = "", title = "", book = "", cursor = false } = {}) {
  let placed = !cursor;
  return text.replace(VAR, (_, name, format) => {
    const custom = format?.trim();
    switch (name) {
      case "日期": return formatDate(date, custom || "yyyy-MM-dd");
      case "时间": return formatDate(date, custom || "HH:mm");
      case "星期": return formatDate(date, "dddd");
      case "日期时间": return formatDate(date, custom || dateFormat);
      case "标题": return title;
      case "笔记本": return book;
      default:
        if (placed) return "";
        placed = true;
        return CURSOR;
    }
  });
}
