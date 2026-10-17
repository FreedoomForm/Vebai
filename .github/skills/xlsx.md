# SKILL: XLSX (openpyxl) — Excel-таблицы

## Каркас

```python
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

wb = Workbook()
ws = wb.active
ws.title = 'Данные'

hdr_fill = PatternFill('solid', fgColor='2450A4')
hdr_font = Font(bold=True, color='FFFFFF', name='Liberation Sans', size=11)
thin = Side(style='thin', color='B9C6DD')
border = Border(left=thin, right=thin, top=thin, bottom=thin)

ws.append(['Дата', 'Выручка', 'Расходы', 'Прибыль'])
for c in ws[1]:
    c.fill, c.font, c.border = hdr_fill, hdr_font, border
    c.alignment = Alignment(horizontal='center', vertical='center')

for row in rows:                       # rows = данные (числа как числа, не строки!)
    ws.append(row)

# форматы чисел: деньги '#,##0.00 ₽', проценты '0.0%', даты 'DD.MM.YYYY'
for r in range(2, ws.max_row + 1):
    ws.cell(r, 2).number_format = '#,##0.00 ₽'
    ws.cell(r, 4).value = f'=B{r}-C{r}'          # формулы живут в Excel

ws.freeze_panes = 'A2'                            # шапка закреплена
ws.auto_filter.ref = ws.dimensions                # фильтры

# ширина колонок по содержимому
for col in range(1, ws.max_column + 1):
    w = max(len(str(ws.cell(r, col).value or '')) for r in range(1, ws.max_row + 1))
    ws.column_dimensions[get_column_letter(col)].width = min(w + 3, 40)
```

## Правила

- Числа — числами (не строками!), иначе формулы и фильтры не работают.
- Один лист = одна точка зрения («Данные», «Итоги», «Справка»).
- Итоги: SUM/СРЗНАЧ формулами, не хардкодом.
- Сохраняй в /tmp/ws с понятным именем.

## Проверка (обязательна)

```bash
python3 - << 'EOF'
from openpyxl import load_workbook
import os
p = '/tmp/ws/имя.xlsx'
wb = load_workbook(p)
ws = wb.active
print(os.path.getsize(p), 'байт | листы:', wb.sheetnames, '| строк:', ws.max_row)
EOF
```
