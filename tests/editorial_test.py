import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location('editorial', ROOT / 'review/editorial.py')
import sys
sys.path.insert(0, str(ROOT / 'review'))
editorial = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(editorial)


class EditorialTest(unittest.TestCase):
    def test_neighbours_follow_only_target_branch(self):
        def entry(name, parent, role, text, stop='stop'):
            return {'type': 'message', 'id': name, 'parentId': parent,
                    'message': {'role': role, 'content': text if role == 'user' else [{'type': 'text', 'text': text}],
                                'stopReason': stop}}
        entries = [{'type': 'session', 'id': 'session'},
                   entry('u1', None, 'user', 'user before'),
                   entry('a1', 'u1', 'assistant', 'assistant before'),
                   entry('t', 'a1', 'assistant', 'target'),
                   entry('other', 'a1', 'assistant', 'unrelated branch'),
                   entry('u2', 't', 'user', 'user after'),
                   entry('a2', 'u2', 'assistant', 'assistant after')]
        self.assertEqual([e['id'] for e in editorial.nearby_messages(entries, 't')],
                         ['u1', 'a1', 't', 'u2', 'a2'])

    def test_prepare_accepts_distinct_sample_indexes_without_reusing_default_batch(self):
        import hashlib
        text = 'Меняем runtime сейчас.'
        digest = hashlib.sha256(text.encode()).hexdigest()
        record = {'session_id': 'session', 'entry_id': 'target', 'text_sha256': digest}
        label = {'text_sha256': digest, 'overall': 'acceptable',
                 'ranges': [{'start': 7, 'end': 14, 'text': 'runtime'}]}
        entries = [{'type': 'session', 'id': 'session'},
                   {'type': 'message', 'id': 'user', 'parentId': None,
                    'message': {'role': 'user', 'content': 'Запрос'}},
                   {'type': 'message', 'id': 'target', 'parentId': 'user',
                    'message': {'role': 'assistant', 'stopReason': 'stop',
                                'content': [{'type': 'text', 'text': text}]}}]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sample = root / 'sample.jsonl'
            sample.write_text('\n'.join(json.dumps(record) for _ in range(2)) + '\n')
            annotations = root / 'annotations.json'
            annotations.write_text(json.dumps({editorial.review_id(record): label}))
            with patch.object(editorial, 'locate_session', return_value=(root / 'session.jsonl', {'cwd': str(root)}, entries)), \
                 patch.object(editorial, 'project_snapshot', return_value={'status': 'unavailable', 'files': []}):
                editorial.prepare(sample, annotations, root, root / 'batch', (2,))
                with self.assertRaises(ValueError):
                    editorial.prepare(sample, annotations, root, root / 'duplicate', (1, 1))
                with self.assertRaises(ValueError):
                    editorial.prepare(sample, annotations, root, root / 'out-of-bounds', (3,))
            cards = json.loads((root / 'batch/cards-base.json').read_text())['cards']
            self.assertEqual([c['id'] for c in cards], ['card-02'])
            self.assertEqual(cards[0]['source'][cards[0]['start']:cards[0]['end']], 'runtime')
            self.assertFalse((root / 'duplicate').exists())


    def test_excerpt_contains_exact_highlight(self):
        text = 'Начало. Английский readback здесь лишний. Следующее предложение.'
        start = text.index('readback')
        excerpt, left, right = editorial.source_excerpt(text, start, start + 8)
        self.assertEqual(excerpt[left:right], 'readback')

    def test_source_answer_window_preserves_highlight_and_nearby_text(self):
        text = 'Начало ответа. Выделение. Последнее пояснение.'
        start = text.index('Выделение')
        whole = editorial.answer_window(text, start, start + len('Выделение'))
        self.assertEqual(whole['text'], text)
        self.assertFalse(whole['truncated'])
        long_text = 'Вступление.\n' + ('абзац с пояснением.\n' * 200) + 'Целевая фраза.\n' + ('ещё текст.\n' * 200)
        start = long_text.index('Целевая фраза')
        window = editorial.answer_window(long_text, start, start + len('Целевая фраза'))
        self.assertTrue(window['truncated'])
        self.assertEqual(window['text'][window['start']:window['end']], 'Целевая фраза')
        self.assertIn('абзац с пояснением', window['text'])
        self.assertIn('ещё текст', window['text'])
        self.assertLess(len(window['text']), len(long_text))
        with self.assertRaises(ValueError):
            editorial.answer_window(text, len(text), len(text) + 1)


    def test_context_preview_never_cuts_a_word_without_marker(self):
        text = 'Вводная строка.\nПолное пояснение про маркер.\nСледующий раздел содержит ещё много слов.'
        preview = editorial.clip_context(text, 53)
        self.assertTrue(preview.endswith('…'))
        self.assertIn('Полное пояснение про маркер.', preview)
        self.assertNotIn('Следующий раздел', preview)

    def test_editor_checks_context_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cards = root / 'cards.json'
            context = root / 'context.json'
            cards.write_text(json.dumps({'cards': [{'id': 'c', 'source_sha256': 'hash'}]}))
            context.write_text(json.dumps({'contexts': {'c': {'source_sha256': 'hash', 'first_request': 'Исходная задача'}}}))
            editor = editorial.Editor(cards, root / 'choices.json', context)
            self.assertEqual(editor.cards[0]['context']['first_request'], 'Исходная задача')
            context.write_text(json.dumps({'contexts': {'c': {'source_sha256': 'other'}}}))
            with self.assertRaises(ValueError):
                editorial.Editor(cards, root / 'choices.json', context)


    def test_editor_saves_separate_choices_and_rejects_invalid_values(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cards = root / 'cards.json'
            cards.write_text(json.dumps({'cards': [{'id': 'c', 'source_sha256': 'hash', 'variants': [
                {'text': str(n), 'why': 'why'} for n in range(3)]}]}))
            choices = root / 'choices.json'
            app = editorial.Editor(cards, choices)
            item = {'id': 'c', 'source_sha256': 'hash', 'mode': 'variants', 'picks': [0, 2],
                    'comment': 'свой комментарий', 'own': 'моя редакция'}
            app.choose(item)
            self.assertEqual(choices.stat().st_mode & 0o777, 0o600)
            self.assertEqual(editorial.Editor(cards, choices).choices['c']['picks'], [0, 2])
            for invalid in ({**item, 'source_sha256': 'changed'}, {**item, 'picks': [9]},
                            {**item, 'picks': []}, {**item, 'mode': 'none'},
                            {**item, 'comment': 'x' * 3001}):
                with self.assertRaises(ValueError):
                    app.choose(invalid)
            self.assertEqual(app.choices['c'], item)

    def test_project_paths_cannot_escape_allowed_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'hobby' / 'project'
            root.mkdir(parents=True)
            (root / 'README.md').write_text('documentation')
            outside = root.parent / 'private.md'
            outside.write_text('secret content')
            with patch.object(editorial.Path, 'home', return_value=Path(directory)):
                data = editorial.project_snapshot(str(root), '`../private.md`')
            self.assertEqual([f['path'] for f in data['files']], ['README.md'])
            self.assertNotIn('secret content', str(data))

    def test_deleted_worktree_falls_back_only_to_unique_project(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            main = home / 'hobby' / 'project'
            main.mkdir(parents=True)
            (main / 'AGENTS.md').write_text('project language rules')
            gone = str(home / 'deleted-worktree' / 'project')
            with patch.object(editorial.Path, 'home', return_value=home):
                found = editorial.project_snapshot(gone, '')
                self.assertEqual(found['status'], 'unique same-name project; original cwd unavailable')
                self.assertEqual(found['files'][0]['path'], 'AGENTS.md')
                (home / 'work' / 'project').mkdir(parents=True)
                missing = editorial.project_snapshot(gone, '')
                self.assertEqual(missing['files'], [])
                self.assertEqual(missing['status'], 'project unavailable; no substitute used')


if __name__ == '__main__':
    unittest.main()
