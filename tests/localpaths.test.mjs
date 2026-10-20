import { test } from "node:test";
import assert from "node:assert/strict";
import { findLocalPaths } from "../src/js/localpaths.js";

test("Windows drive, UNC and file URLs are recognized without changing source text", () => {
  const examples = [
    "C:\\资料\\a.pdf",
    "\\\\NAS\\共享\\b.docx",
    "file:///D:/文档/a%20b.pdf",
    "\"D:\\我的 文档\\a.pdf\"",
    "<D:\\我的 文档\\a.pdf>",
  ];
  for (const source of examples) {
    const matches = findLocalPaths(source);
    assert.equal(matches.length, 1, source);
    assert.equal(source.slice(matches[0].from, matches[0].to), matches[0].path);
  }
});

test("relative or ambiguous paths and URL fragments are excluded", () => {
  for (const source of ["C:", "a\\b", "https://example.com/C:/file",
                         "普通文字", "abcD:\\文档\\a.pdf"]) {
    assert.deepEqual(findLocalPaths(source), [], source);
  }
});

test("unquoted paths stop at spaces and punctuation; quoted paths may contain spaces", () => {
  const source = "打开 C:\\文档\\a.pdf，然后打开 \"D:\\我的 文档\\b.pdf\"。";
  assert.deepEqual(findLocalPaths(source).map((x) => x.path), [
    "C:\\文档\\a.pdf", "D:\\我的 文档\\b.pdf",
  ]);
});

test("Chinese prose directly surrounding a path is not included in the path", () => {
  for (const source of ["打开D:\\资料\\a.pdf", "路径是D:\\资料\\a.pdf", "D:\\资料\\a.pdf里面"]) {
    assert.deepEqual(findLocalPaths(source).map((x) => x.path), ["D:\\资料\\a.pdf"], source);
  }
});
