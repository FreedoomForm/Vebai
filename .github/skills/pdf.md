# SKILL: PDF (reportlab) — русский текст, структура, проверка

## 1. Шрифты (ОБЯЗАТЕЛЬНО — без этого кириллица = чёрные квадраты)

```python
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
pdfmetrics.registerFont(TTFont('DejaVu', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'))
pdfmetrics.registerFont(TTFont('DejaVu-Bold', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'))
pdfmetrics.registerFont(TTFont('DejaVu-Italic', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf'))
```
Все стили указывают fontName='DejaVu' / 'DejaVu-Bold'. Никаких Helvetica/Times.

## 2. Каркас документа

```python
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table,
                                TableStyle, PageBreak, Image, HRFlowable)
from reportlab.lib.styles import ParagraphStyle

body = ParagraphStyle('body', fontName='DejaVu', fontSize=10.5, leading=15,
                      alignment=4, spaceAfter=6)          # alignment=4 = justify
h1 = ParagraphStyle('h1', fontName='DejaVu-Bold', fontSize=20, leading=26,
                    textColor=colors.HexColor('#1a2b4a'), spaceAfter=10)
h2 = ParagraphStyle('h2', fontName='DejaVu-Bold', fontSize=14, leading=19,
                    textColor=colors.HexColor('#2450a4'), spaceBefore=10, spaceAfter=6)

doc = SimpleDocTemplate('/tmp/ws/имя_файла.pdf', pagesize=A4,
                        topMargin=18*mm, bottomMargin=18*mm,
                        leftMargin=20*mm, rightMargin=20*mm,
                        title='Название', author='Vebai Agent')
story = [Paragraph('Заголовок', h1), HRFlowable(width='100%', thickness=1,
         color=colors.HexColor('#2450a4')), Paragraph('Текст…', body), ...]
doc.build(story)
```

## 3. Таблицы

```python
data = [['Колонка 1', 'Колонка 2'], ['a', 'b']]
t = Table(data, colWidths=[70*mm, 70*mm])
t.setStyle(TableStyle([
    ('FONTNAME', (0,0), (-1,0), 'DejaVu-Bold'), ('FONTNAME', (0,1), (-1,-1), 'DejaVu'),
    ('FONTSIZE', (0,0), (-1,-1), 9.5),
    ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#2450a4')),
    ('TEXTCOLOR', (0,0), (-1,0), colors.white),
    ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.white, colors.HexColor('#eef3fb')]),
    ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor('#b9c6dd')),
    ('PADDING', (0,0), (-1,-1), 5),
]))
```

## 4. Палитра (деловая, используй её)

- Тёмно-синий заголовков: #1a2b4a; акцент: #2450a4; фон зебры: #eef3fb;
- линии: #b9c6dd; вторичный текст: #555555. Один документ = одна акцентная линия.

## 4b. Колонтитулы + нумерация страниц (для отчётов от 2 страниц)

```python
def on_page(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(colors.HexColor('#b9c6dd')); canvas.setLineWidth(0.5)
    canvas.line(20*mm, 285*mm, 190*mm, 285*mm)          # верхняя линия
    canvas.setFont('DejaVu', 8); canvas.setFillColor(colors.HexColor('#555555'))
    canvas.drawString(20*mm, 287*mm, 'ОТЧЁТ: название')
    canvas.drawRightString(190*mm, 287*mm, time.strftime('%d.%m.%Y'))
    canvas.drawCentredString(105*mm, 12*mm, f'— {doc.page} —')  # номер внизу
    canvas.restoreState()

doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
```

## 4c. Графики внутрь PDF (matplotlib → PNG → Image)

```python
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
fig, ax = plt.subplots(figsize=(7, 3.2), constrained_layout=True)
ax.bar(labels, values, color='#2450a4')
ax.set_title('Заголовок графика', fontsize=11)
fig.savefig('/tmp/ws/chart1.png', dpi=160); plt.close(fig)
# в story: Image('/tmp/ws/chart1.png', width=165*mm, height=75*mm) + подпись мелким стилем
```
Стиль matplotlib: цвета из палитры (#2450a4, #1a2b4a), сетка снизу
(`ax.grid(axis='y', alpha=.3)`), подписи осей, кириллица работает из коробки.

## 4d. Оглавление (простое, вручную)

После титула: заголовок «Содержание» (h2) + список «1. Раздел … 2. Раздел»
обычным body-стилем, затем PageBreak. Номера разделов дублируй в самих h1/h2
(«1. Введение», «2. Данные»), чтобы оглавление соответствовало документу.

## 5. Требования к содержанию

- Отчёт = 3+ содержательных раздела + «Выводы»: введение (что и зачем),
  данные/методика, анализ с цифрами и графиком, выводы.
- Каждый раздел — содержательный текст (абзац = 3+ предложения), а не заглушки.
- Цифры из задачи/поиска — в таблицу или список; каждый график имеет подпись.
- Длинные тексты: PageBreak между крупными разделами, если не влезают.

## 6. Проверка (обязательна перед <final>)

```bash
python3 - << 'EOF'
from pypdf import PdfReader
import os
p = '/tmp/ws/имя_файла.pdf'
r = PdfReader(p)
print(os.path.getsize(p), 'байт,', len(r.pages), 'стр.')
t = r.pages[0].extract_text()[:200]
print('текст читается:', 'да' if len(t) > 20 else 'НЕТ — проблема со шрифтом!')
EOF
ls -la /tmp/ws/*.pdf
```
Если extract_text пустой — шрифты не зарегистрированы, переделай.
