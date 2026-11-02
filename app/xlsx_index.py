"""xlsx 索引文件解析（纯标准库，流式，零新增依赖）。

针对「短剧列表」类 WPS/Excel 导出：单 sheet 三列（短剧名称 | 地址 | 更新日期），
其中地址存放在单元格超链接（worksheets/_rels/*.rels）而非单元格值本身
（B 列显示文本通常是「查看」）；日期是 Excel 日期序列号（1899-12-30 基准）。

约定：解析阶段不碰数据库；坏行（无标题/非 http 链接）原样产出，由调用方计数过滤。
"""
import io
import re
import zipfile
import xml.etree.ElementTree as ET
from datetime import date, timedelta

MAIN_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
DOC_REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"

_EPOCH = date(1899, 12, 30)
_CELL_RE = re.compile(r"([A-Z]+)(\d+)")
_DATE_RE = re.compile(r"^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$")


class XlsxError(ValueError):
    """xlsx 不可解析；message 面向最终用户。"""


def _col_index(ref: str) -> int:
    """'B2' → 列序号 1（A=0）；无 r 属性时返回 -1。"""
    m = _CELL_RE.match(ref or "")
    if not m:
        return -1
    n = 0
    for ch in m.group(1):
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def _normalize_target(target: str) -> str:
    t = (target or "").lstrip("/")
    return t if t.startswith("xl/") else "xl/" + t


def _first_sheet_path(zf: zipfile.ZipFile) -> str:
    try:
        wb = ET.fromstring(zf.read("xl/workbook.xml"))
        first = wb.find(f".//{MAIN_NS}sheet")
        rid = first.get(DOC_REL_NS + "id") if first is not None else None
        rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
        for r in rels:
            if r.get("Id") == rid:
                return _normalize_target(r.get("Target", ""))
    except (KeyError, ET.ParseError):
        pass
    if "xl/worksheets/sheet1.xml" in zf.namelist():
        return "xl/worksheets/sheet1.xml"
    sheets = sorted(n for n in zf.namelist() if n.startswith("xl/worksheets/") and n.endswith(".xml"))
    if not sheets:
        raise XlsxError("xlsx 里没有工作表")
    return sheets[0]


def _load_shared_strings(zf: zipfile.ZipFile) -> list:
    if "xl/sharedStrings.xml" not in zf.namelist():
        return []
    strings = []
    try:
        for _event, el in ET.iterparse(zf.open("xl/sharedStrings.xml"), events=("end",)):
            if el.tag == MAIN_NS + "si":
                strings.append("".join(t.text or "" for t in el.iter(MAIN_NS + "t")))
                el.clear()
    except ET.ParseError as e:
        raise XlsxError(f"sharedStrings 解析失败：{e}")
    return strings


def _load_hyperlinks(zf: zipfile.ZipFile, sheet_path: str) -> dict:
    """{单元格引用: 超链接目标} —— 分享链接实际存放处。"""
    rels_path = sheet_path.rsplit("/", 1)[0] + "/_rels/" + sheet_path.rsplit("/", 1)[1] + ".rels"
    targets = {}
    if rels_path in zf.namelist():
        try:
            rels = ET.fromstring(zf.read(rels_path))
            targets = {r.get("Id"): r.get("Target", "") for r in rels}
        except ET.ParseError:
            pass
    links = {}
    try:
        with zf.open(sheet_path) as f:
            for _event, el in ET.iterparse(f, events=("end",)):
                if el.tag == MAIN_NS + "hyperlink":
                    rid = el.get(DOC_REL_NS + "id")
                    ref = el.get("ref", "")
                    if rid and ref and rid in targets:
                        links[ref] = targets[rid]
                    el.clear()
                elif el.tag != MAIN_NS + "hyperlinks":
                    pass  # 其余节点在 rows 遍历时再清，这里仅收集 hyperlink
    except ET.ParseError as e:
        raise XlsxError(f"工作表超链接解析失败：{e}")
    return links


def _cell_value(c, shared: list):
    t = c.get("t")
    if t == "inlineStr":
        return "".join(x.text or "" for x in c.iter(MAIN_NS + "t"))
    v = c.find(MAIN_NS + "v")
    raw = v.text if v is not None else None
    if raw is None:
        return ""
    if t == "s":
        try:
            return shared[int(raw)]
        except (ValueError, IndexError):
            return ""
    return raw


def _date_text(value: str) -> str:
    value = (value or "").strip()
    if not value:
        return ""
    try:  # Excel 序列号（含小数时间尾数）
        return (_EPOCH + timedelta(days=int(float(value)))).isoformat()
    except ValueError:
        pass
    m = _DATE_RE.match(value)
    if m:
        y, mo, d = (int(x) for x in m.groups())
        try:
            return date(y, mo, d).isoformat()
        except ValueError:
            return ""
    return ""


def parse_xlsx_index(data: bytes):
    """流式产出 (title, url, updated_date)；坏行（空标题/非 http 链接）也产出，由调用方计数。

    结构异常抛 XlsxError（面向用户）；zip 损坏同样包装为 XlsxError。
    """
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise XlsxError("不是有效的 xlsx 文件（zip 损坏或格式不支持）")

    with zf:
        sheet_path = _first_sheet_path(zf)
        shared = _load_shared_strings(zf)
        links = _load_hyperlinks(zf, sheet_path)
        try:
            with zf.open(sheet_path) as f:
                for _event, row in ET.iterparse(f, events=("end",)):
                    if row.tag != MAIN_NS + "row":
                        continue
                    row_ref = row.get("r") or ""
                    cells = {}
                    for c in row.findall(MAIN_NS + "c"):
                        ref = c.get("r")
                        idx = _col_index(ref) if ref else -1
                        if idx < 0:
                            idx = len(cells)
                        cells[idx] = _cell_value(c, shared)
                    row.clear()
                    if not cells:
                        continue
                    title = (cells.get(0) or "").strip()
                    url_cell = (cells.get(1) or "").strip()
                    # 链接优先取超链接目标，其次单元格值（部分导出直接写 URL）
                    ref_b = f"B{row_ref}" if row_ref else ""
                    url = (links.get(ref_b) or url_cell).strip() if ref_b else url_cell
                    if title == "短剧名称":  # 表头
                        continue
                    if not title and not url and not (cells.get(2) or "").strip():
                        continue  # 全空行
                    yield title, url, _date_text(cells.get(2) or "")
        except ET.ParseError as e:
            raise XlsxError(f"工作表解析失败：{e}")
