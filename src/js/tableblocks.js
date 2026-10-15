// ---------- 表格块：行、列与表头操作 ----------
// 复用现有 GFM table / cell schema；不会引入非标准 Markdown 表格字段。
import { TextSelection, closeHistory } from "../vendor/milkdown.js";

function blankCell(schema, like) {
  return like.type.create(like.attrs, schema.nodes.paragraph.create());
}

function blankRow(schema, like) {
  return like.type.create(like.attrs, Array.from({ length: like.childCount }, (_, i) => like.child(i)).map((cell) => blankCell(schema, cell)));
}

export function tableAction(view, pos, command, row = 0, col = 0) {
  if (!view.editable) return false;
  const state = view.state;
  const table = state.doc.nodeAt(pos);
  if (table?.type.name !== "table") return false;
  const rows = Array.from({ length: table.childCount }, (_, i) => table.child(i));
  row = Math.min(Math.max(0, row), rows.length - 1);
  col = Math.min(Math.max(0, col), rows[0].childCount - 1);
  const columns = rows[0].childCount;

  if (command === "row-above" || command === "row-below") {
    // 表头只能保持在第一行；在表头之上插普通行会破坏 GFM schema。
    const at = command === "row-above" ? Math.max(1, row) : row + 1;
    const template = rows[Math.min(Math.max(1, row), rows.length - 1)] || rows[0];
    let next = blankRow(state.schema, template);
    if (next.type.name === "table_header_row") {
      next = state.schema.nodes.table_row.create(null,
        Array.from({ length: next.childCount }, (_, i) => next.child(i)).map((cell) => state.schema.nodes.table_cell.create(null, cell.content)));
    }
    rows.splice(at, 0, next);
  } else if (command === "row-delete") {
    if (rows.length <= 1) return false;
    rows.splice(row, 1);
  } else if (command === "row-duplicate") {
    // 复制表头时以普通行插入，保持表头唯一。
    const original = rows[row];
    const duplicate = original.type.name === "table_header_row"
      ? state.schema.nodes.table_row.create(null,
        Array.from({ length: original.childCount }, (_, i) => original.child(i)).map((cell) => state.schema.nodes.table_cell.create(null, cell.content)))
      : original;
    rows.splice(row + 1, 0, duplicate);
  } else if (command === "row-up" || command === "row-down") {
    const other = row + (command === "row-up" ? -1 : 1);
    if (row === 0 || other < 1 || other >= rows.length) return false;
    [rows[row], rows[other]] = [rows[other], rows[row]];
  } else if (command === "col-left" || command === "col-right" || command === "col-delete") {
    if (command === "col-delete" && columns === 1) return false;
    for (let i = 0; i < rows.length; i++) {
      const cells = Array.from({ length: rows[i].childCount }, (_, j) => rows[i].child(j));
      if (command === "col-delete") cells.splice(col, 1);
      else cells.splice(col + (command === "col-right" ? 1 : 0), 0, blankCell(state.schema, cells[col]));
      rows[i] = rows[i].type.create(rows[i].attrs, cells);
    }
  } else return false;

  const next = table.type.create(table.attrs, rows);
  if (!next.type.validContent(next.content)) return false;
  const tr = closeHistory(state.tr).replaceWith(pos, pos + table.nodeSize, next);
  view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos + 3, tr.doc.content.size)))).scrollIntoView());
  view.focus();
  return true;
}

export function tableItems(view, pos, row, col) {
  const table = view.state.doc.nodeAt(pos);
  if (table?.type.name !== "table") return [];
  const command = (id, label, disabled = false) => ({
    id: "block-table-" + id,
    label,
    disabled,
    act: () => tableAction(view, pos, id, row, col),
  });
  return [
    command("row-above", "表格：上方插入行"),
    command("row-below", "表格：下方插入行"),
    command("row-duplicate", "表格：复制此行"),
    command("row-delete", "表格：删除此行", table.childCount <= 1),
    command("row-up", "表格：此行上移", row < 2),
    command("row-down", "表格：此行下移", row === 0 || row >= table.childCount - 1),
    command("col-left", "表格：左侧插入列"),
    command("col-right", "表格：右侧插入列"),
    command("col-delete", "表格：删除此列", table.firstChild.childCount <= 1),
  ];
}
