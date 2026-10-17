# SKILL: DOCX (python-docx) — Word-документы

## Каркас

```python
from docx import Document
from docx.shared import Pt, Mm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH

doc = Document()
st = doc.styles['Normal']
st.font.name = 'Liberation Sans'   # есть кириллица на runner'е
st.font.size = Pt(11)

h = doc.add_heading('Название документа', level=0)   # level 0 = Title
p = doc.add_paragraph('Вводный абзац: о чём документ, дата, автор.')
p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
doc.add_heading('Раздел 1', level=1)
doc.add_paragraph('Содержательный текст абзаца (3+ предложения)...')

# список
for item in ['пункт 1', 'пункт 2']:
    doc.add_paragraph(item, style='List Bullet')

# таблица
t = doc.add_table(rows=1, cols=3)
t.style = 'Table Grid'
hdr = t.rows[0].cells
for i, name in enumerate(['Колонка A', 'B', 'C']):
    hdr[i].text = name
    hdr[i].paragraphs[0].runs[0].bold = True
```

## Правила

- Заголовки через add_heading (уровни 0-3) — тогда работает навигация по документу.
- Абзацы — содержательные (3+ предложения), выравнивание justify для основного текста.
- Таблицы: стиль 'Table Grid', жирная шапка; числа справа, текст слева.
- Страничные разрывы — только между крупными разделами: `doc.add_page_break()`.
- Сохраняй в /tmp/ws с понятным именем: `doc.save('/tmp/ws/otchet.docx')`.

## Проверка (обязательна)

```bash
python3 - << 'EOF'
from docx import Document
import os
p = '/tmp/ws/otchet.docx'
d = Document(p)
print(os.path.getsize(p), 'байт |', len(d.paragraphs), 'абзацев |', len(d.tables), 'таблиц')
EOF
```
Файл должен открываться повторно без ошибок.
