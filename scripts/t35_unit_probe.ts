/** T35 TS unit probe: answer-protocol verdict + fallback parsing (run via jiti). */
import { checkAnswerProtocol, formatRetryNote, parseAiAnswer, fileWants } from '../src/lib/agent/answer'

let fails = 0
function check(name: string, cond: boolean, detail?: unknown) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' :: ' + JSON.stringify(detail)?.slice(0, 200)))
  if (!cond) fails++
}

// ok cases
check('tagged ok', checkAnswerProtocol('план план <answer>Привет!</answer>').ok === true)
check('tagged with junk outside ok', checkAnswerProtocol('<think>ммм</think>размышляю <answer>Ответ</answer> <file>a.pdf</file>').ok === true)
check('empty string -> empty', checkAnswerProtocol('').reason === 'empty')
check('whitespace -> empty', checkAnswerProtocol('   \n ').reason === 'empty')
check('empty answer tag -> empty_answer', checkAnswerProtocol('<answer></answer>').reason === 'empty_answer')
check('two empty answers -> empty_answer', checkAnswerProtocol('<answer></answer>\n<answer> </answer>').reason === 'empty_answer')
check('untagged text -> no_answer_tag', checkAnswerProtocol('Я сделал всё, вот отчёт').reason === 'no_answer_tag')
check('unclosed answer with tail -> ok', checkAnswerProtocol('план<answer>Тут ответ обрывается').ok === true)
check('unclosed empty answer -> not ok', checkAnswerProtocol('план<answer>').ok === false)

// formatRetryNote
check('note empty', formatRetryNote('empty').includes('ПУСТЫМ'))
check('note empty_answer', formatRetryNote('empty_answer').includes('ПУСТЫМ'))
check('note untagged', formatRetryNote('no_answer_tag').includes('БЕЗ обёртки'))

// parseAiAnswer regressions (T16 behaviour intact)
const p = parseAiAnswer('служебка <answer>видимый текст</answer> <file>otchet.pdf</file> <file>/tmp/ws/graf.png</file>')
check('parse text', p.text === 'видимый текст' && p.tagged, p)
check('parse files', p.files.join(',') === 'otchet.pdf,graf.png', p.files)
check('fallback untagged', parseAiAnswer('голый ответ').text === 'голый ответ')

// fileWants regressions
check('fileWants basename', fileWants(['otchet.pdf'], '/tmp/ws/sub/otchet.pdf') === true)
check('fileWants miss', fileWants(['a.pdf'], 'b.pdf') === false)

console.log()
console.log('T35 TS PROBE:', fails === 0 ? 'ALL PASS' : `${fails} FAIL`)
process.exit(fails === 0 ? 0 : 1)
