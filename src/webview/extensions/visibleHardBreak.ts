import { HardBreak } from '@tiptap/extension-hard-break';

export const VisibleHardBreak = HardBreak.extend({
  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      { class: 'hard-break-wrapper' },
      ['span', { class: 'hard-break-label', contenteditable: 'false' }, '<br />'],
      ['br', HTMLAttributes],
    ];
  },
});
