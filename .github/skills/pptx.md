# SKILL: PPTX (python-pptx) — презентации

## Каркас (16:9!)

```python
from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN

prs = Presentation()
prs.slide_width = Inches(13.33)      # 16:9
prs.slide_height = Inches(7.5)

NAVY, ACCENT, GREY = RGBColor(0x1a,0x2b,0x4a), RGBColor(0x24,0x50,0xa4), RGBColor(0x55,0x55,0x55)

# титульный слайд (layout 0)
s = prs.slides.add_slide(prs.slide_layouts[0])
s.shapes.title.text = 'Название'
s.placeholders[1].text = 'Подзаголовок • дата • Vebai Agent'

# контентный слайд (layout 1)
s = prs.slides.add_slide(prs.slide_layouts[1])
s.shapes.title.text = 'Заголовок слайда'
tf = s.placeholders[1].text_frame
tf.text = 'Главный тезис слайда'
for point in ['факт 1', 'факт 2', 'факт 3']:
    p = tf.add_paragraph(); p.text = point; p.level = 1

# картинка (например, график из skills/charts.md)
s = prs.slides.add_slide(prs.slide_layouts[5])          # Title Only
s.shapes.title.text = 'График'
s.shapes.add_picture('/tmp/ws/grafik.png', Inches(1.2), Inches(1.8), width=Inches(10.9))

prs.save('/tmp/ws/prezentaciya.pptx')
```

## Правила качества

- ≤ 6 буллетов на слайд, ≤ 12 слов в буллете; суть — в заголовке слайда.
- Один слайд = одна мысль. Титул → план → разделы → выводы → «Спасибо за внимание».
- Шрифт заголовков ≥ 28pt, текста ≥ 18pt. Не перегружай цветом: NAVY + ACCENT.
- Графики вставляй КАРТИНКАМИ (сгенерируй через matplotlib, dpi=200).
- 8-12 слайдов — стандарт для доклада.

## Проверка (обязательна)

```bash
python3 - << 'EOF'
from pptx import Presentation
import os
p = '/tmp/ws/prezentaciya.pptx'
prs = Presentation(p)
print(os.path.getsize(p), 'байт |', len(prs.slides.__iter__.__self__._sldIdLst), 'слайдов')
print('слайдов:', len(prs.slides._sldIdLst))
EOF
```
