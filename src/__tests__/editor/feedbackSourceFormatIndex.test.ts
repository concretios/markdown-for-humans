import { createFeedbackSourceFormatIndex } from '../../editor/feedbackSourceFormatIndex';

describe('Frozen source-format range index', () => {
  it('classifies sparse complete-block ranges without treating empty ordinal gaps as text', () => {
    const index = createFeedbackSourceFormatIndex([
      { ordinal: 0, format: 'markdown' },
      { ordinal: 2, format: 'markdown' },
      { ordinal: 5, format: 'html' },
      { ordinal: 7, format: 'text' },
    ]);
    expect(index(0, 2)).toBe('markdown');
    expect(index(2, 5)).toBe('text');
    expect(index(5, 5)).toBe('html');
    expect(index(7, 7)).toBe('text');
    expect(index(20, 21)).toBe('text');
  });
});
