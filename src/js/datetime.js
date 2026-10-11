// ---------- F5 插入的日期时间 ----------
// 格式的写法和 Windows 一样:yyyy / yy 年,M / MM 月,d / dd 日,ddd 周几,dddd 星期几,
// H / HH 时(24 小时制),h / hh 时(12 小时制),tt 上午或下午,m / mm 分,s / ss 秒;
// 其他字符原样保留,要原样输出字母就用引号括起来,比如 'week'。

// 和中文 Windows 记事本按 F5 插入的一样,比如 13:45 2026/10/11
export const DEFAULT_DATE_FORMAT = "H:mm yyyy/M/d";

const TOKEN = /yyyy|yy|MM|M|dddd|ddd|dd|d|HH|H|hh|h|tt|mm|m|ss|s|'[^']*'|"[^"]*"/g;
const WEEK = "日一二三四五六";

export function formatDate(date, format) {
  const pad = (n) => String(n).padStart(2, "0");
  const h = date.getHours();
  return (format || DEFAULT_DATE_FORMAT).replace(TOKEN, (t) => {
    switch (t) {
      case "yyyy": return String(date.getFullYear());
      case "yy": return pad(date.getFullYear() % 100);
      case "MM": return pad(date.getMonth() + 1);
      case "M": return String(date.getMonth() + 1);
      case "dddd": return "星期" + WEEK[date.getDay()];
      case "ddd": return "周" + WEEK[date.getDay()];
      case "dd": return pad(date.getDate());
      case "d": return String(date.getDate());
      case "HH": return pad(h);
      case "H": return String(h);
      case "hh": return pad(h % 12 || 12);
      case "h": return String(h % 12 || 12);
      case "tt": return h < 12 ? "上午" : "下午";
      case "mm": return pad(date.getMinutes());
      case "m": return String(date.getMinutes());
      case "ss": return pad(date.getSeconds());
      case "s": return String(date.getSeconds());
      // 引号里的原样输出
      default: return t.slice(1, -1);
    }
  });
}
