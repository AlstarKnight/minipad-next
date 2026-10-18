// 正文中的 Windows 绝对路径识别；只计算范围，不修改 Markdown 原文。
const candidate = /"[^"\r\n]+"|<[^<>\r\n]+>|[A-Za-z]:[\\/][^\s<>"|?*，。；！？,;!]+|\\\\[^\s\\/]+[\\/][^\s<>"|?*，。；！？,;!]+|file:\/\/\/[A-Za-z]:\/[^\s<>"|?*，。；！？,;!]+/g;
const windowsPath = /^(?:[A-Za-z]:[\\/][^\s\\/].*|\\\\[^\\/\s]+[\\/][^\\/\s].*|file:\/\/\/[A-Za-z]:\/[^\s/].*)$/i;
const trailing = /[.,;!?。，；！？]+$/;

export function findLocalPaths(text) {
  const paths = [];
  for (const match of text.matchAll(candidate)) {
    const raw = match[0];
    const begin = match.index;
    const wrapped = (raw[0] === '"' && raw.at(-1) === '"') ||
      (raw[0] === '<' && raw.at(-1) === '>');
    const start = begin + (wrapped ? 1 : 0);
    let end = begin + raw.length - (wrapped ? 1 : 0);
    let path = text.slice(start, end);
    if (!wrapped) {
      // 网址、单词和其它路径片段中间出现的盘符，不视作一个新路径。
      const before = text[begin - 1];
      if (begin > 0 && !/[\s([{（，；]/.test(before)) continue;
      const suffix = trailing.exec(path);
      if (suffix) {
        path = path.slice(0, -suffix[0].length);
        end -= suffix[0].length;
      }
    }
    if (windowsPath.test(path)) paths.push({ from: start, to: end, path });
  }
  return paths;
}
