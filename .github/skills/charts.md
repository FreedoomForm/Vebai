# SKILL: Графики (matplotlib) — правила, чтобы графики были профессиональными

## Обязательные правила (из системы Z.ai)

1. Кириллица: DejaVu Sans работает по умолчанию; НЕ подключай другие шрифты без нужды.
2. Раскладка: ТОЛЬКО `constrained_layout=True` в `plt.subplots(...)`.
   ЗАПРЕЩЕНО смешивать с `tight_layout()`, `subplots_adjust()`, `bbox_inches='tight'`.
3. Легенда при многих сериях — СНАРУЖИ области графика:
   `ax.legend(loc='upper left', bbox_to_anchor=(1.02, 1))`.
4. Заголовок, подписи осей и ЕДИНИЦЫ измерения — всегда.
5. Метки оси X не должны слипаться: поворот `rotation=45, ha='right'` или `range(n)`.
6. Сетка: `ax.grid(alpha=0.3)`. Убери верхнюю/правую рамку:
   `for s in ('top','right'): ax.spines[s].set_visible(False)`.
7. Сохранение: `fig.savefig('/tmp/ws/имя.png', dpi=200)` затем проверь `ls -la`.

## Палитры (выбирай по типу данных)

- Бизнес-серии: ['#2450a4', '#e4572e', '#2e933c', '#7768ae', '#d9a404']
- Категориальная: plt.cm.tab10
- Финансы: рост '#2e933c', падение '#d7263d'

## Пример каркаса

```python
import matplotlib
matplotlib.use('Agg')  # БЕЗ экрана — обязательно на сервере!
import matplotlib.pyplot as plt

fig, ax = plt.subplots(figsize=(9, 5), constrained_layout=True)
for name, y in data.items():
    ax.plot(x, y, marker='o', linewidth=2, label=name)
ax.set_title('Заголовок с сутью', fontsize=14, fontweight='bold')
ax.set_xlabel('Дата'); ax.set_ylabel('Млн ₽')
ax.grid(alpha=0.3)
for s in ('top', 'right'): ax.spines[s].set_visible(False)
ax.legend(loc='upper left', bbox_to_anchor=(1.02, 1))
fig.savefig('/tmp/ws/grafik.png', dpi=200)
```

## Тип графиков по задаче

- Тренд во времени → line; сравнение категорий → bar (горизонт. если подписи длинные);
- структура целого → pie ИЛИ лучше bar (pie только ≤5 долей); связь → scatter;
- распределение → histogram. Аннотируй ключевые точки (max/min) текстом.

## Проверка

`ls -la /tmp/ws/*.png` — размер > 10 КБ; открой файл при сомнениях
(`python3 -c "from PIL import Image; im=Image.open('...'); print(im.size)"`).
