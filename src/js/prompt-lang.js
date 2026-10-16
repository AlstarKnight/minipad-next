// ---------- Prompt:写给 AI 的提示词的上色(0.4.2) ----------
// 代码块语言写 prompt 时用:<标签>、{{变量}}、System: 这样的角色、# 标题、列表、**加粗**、`代码`、
// IMPORTANT / 必须 这类强调词和 <!-- 注释 --> 分别上色。不参与没写语言时的自动猜测。

const NAME = /[A-Za-z_一-龥][\w一-龥:.-]*/;

export function promptLanguage(hljs) {
  const string = [
    { scope: "string", begin: /"/, end: /"/ },
    { scope: "string", begin: /'/, end: /'/ },
  ];
  const variables = [
    { scope: "template-variable", begin: /\{\{/, end: /\}\}/ },
    { scope: "template-variable", begin: /\$\{/, end: /\}/ },
    { scope: "template-variable", begin: new RegExp(`\\{${NAME.source}\\}`) },
    { scope: "template-variable", begin: /\[\[/, end: /\]\]/ },
  ];
  const tag = {
    scope: "tag",
    begin: new RegExp(`</?(?=${NAME.source})`),
    end: /\/?>/,
    contains: [
      { scope: "name", begin: NAME, relevance: 0 },
      { scope: "attr", begin: /[\w-]+(?=\s*=)/, relevance: 0 },
      ...string,
    ],
  };
  const stress = {
    scope: "keyword",
    begin: /\b(?:IMPORTANT|CRITICAL|MUST NOT|MUST|NEVER|ALWAYS|DO NOT|DON'T|NOTE|REQUIRED)\b|重要|注意|必须|务必|禁止|不要|不得|一定/,
  };
  const inline = [
    ...variables,
    tag,
    { scope: "code", begin: /`[^`\n]+`/ },
    { scope: "strong", begin: /\*\*(?=\S)/, end: /\*\*/, contains: [...variables, stress] },
    stress,
  ];
  return {
    name: "Prompt",
    aliases: ["llm"],
    disableAutodetect: true,
    contains: [
      hljs.COMMENT("<!--", "-->"),
      {
        scope: "type",
        begin: /^\s*(?:[Ss]ystem|SYSTEM|[Uu]ser|USER|[Aa]ssistant|ASSISTANT|[Hh]uman|HUMAN|AI|[Dd]eveloper|[Tt]ool|系统|用户|助手)\s*(?=[:：])/,
      },
      { scope: "section", begin: /^#{1,6}\s/, end: /$/, contains: variables },
      { scope: "meta", begin: /^\s*(?:-{3,}|={3,}|\*{3,})\s*$/ },
      { scope: "bullet", begin: /^\s*(?:[-*+•]|\d+[.)、])\s/ },
      ...inline,
    ],
  };
}
