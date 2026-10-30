"""Independent, dependency-free validation of the generated OOXML/ZIP package."""
import sys
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta

with zipfile.ZipFile(sys.argv[1]) as archive:
    assert archive.testzip() is None, "ZIP CRC mismatch"
    parts = {name: ET.fromstring(archive.read(name)) for name in archive.namelist()}
    ns = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    sheet = parts["xl/worksheets/sheet1.xml"]
    cells = {c.attrib["r"]: c for c in sheet.findall(".//s:c", ns)}
    assert cells["A1"].find("s:is/s:t", ns).text == "Компания / представитель"
    assert cells["A2"].find("s:is/s:t", ns).text == "Соня и Лёша"
    assert cells["C2"].attrib["t"] == "n"
    serial = float(cells["K2"].find("s:v", ns).text)
    assert abs((datetime(1899, 12, 30) + timedelta(days=serial) -
                datetime(2026, 10, 30, 0, 15)).total_seconds()) < 0.001
    assert not sheet.findall(".//s:f", ns)
    assert len(sheet.findall("s:cols/s:col", ns)) == 14
    for name, root in parts.items():
        if name.endswith(".rels"):
            for rel in root:
                assert rel.attrib.get("TargetMode") != "External"
    print("PASS: ZIP CRCs, XML parts, Cyrillic, numeric dates, 14 widths, no formulas")
