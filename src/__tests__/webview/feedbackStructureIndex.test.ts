/** @jest-environment jsdom */
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { createFeedbackStructureIndex } from '../../webview/features/feedbackStructureIndex';

describe('frozen Feedback structure index', () => {
  let editor: Editor;
  afterEach(() => editor?.destroy());
  function setup(content: string) {
    editor = new Editor({ extensions: [StarterKit], content });
    return createFeedbackStructureIndex(editor.state.doc);
  }
  it('targets a parent item and descendants, excluding its next sibling', () => {
    const index = setup(
      '<ul><li><p>Parent</p><ul><li><p>Child</p></li></ul><p>Loose tail</p></li><li><p>Sibling</p></li></ul>'
    );
    const parent = index.atPosition(4)!;
    expect(parent.label).toBe('Item and children');
    expect(editor.state.doc.textBetween(parent.from, parent.to, '\n')).toBe(
      'Parent\nChild\nLoose tail'
    );
    expect(index.choices(parent.from + 2).map(choice => choice.label)).toEqual([
      'Whole paragraph',
      'Item and children',
      'Whole bullet list',
    ]);
  });
  it('bounds nested sections by the next peer and by their own quote', () => {
    const index = setup(
      '<blockquote><h2>Mocks</h2><p>Body</p><h3>Child</h3><p>Nested</p><h2>Next</h2><p>Sibling</p></blockquote><p>Outside</p>'
    );
    const section = index.atPosition(3)!;
    expect(section.label).toBe('Section: Mocks');
    expect(editor.state.doc.textBetween(section.from, section.to, '\n')).toBe(
      'Mocks\nBody\nChild\nNested'
    );
    expect(section.wholeBlock).toBe(false);
    expect(index.choices(3).map(choice => choice.label)).toEqual([
      'Whole heading',
      'Section: Mocks',
      'Whole block quote',
    ]);
  });
  it('does not call an opaque subtree exact rendered text', () => {
    const index = setup('<ul><li><p>Parent</p><hr></li><li><p>Sibling</p></li></ul>');
    const scopes = index.choices(4);
    expect(scopes.some(scope => scope.label === 'Item and children')).toBe(false);
    expect(scopes.find(scope => scope.label === 'Whole bullet list')?.wholeBlock).toBe(true);
  });
  it('reuses the frozen index for repeated hits without walking the document', () => {
    const index = setup('<ul><li><p>Parent</p><ul><li><p>Child</p></li></ul></li></ul>');
    const spy = jest.spyOn(editor.state.doc, 'descendants');
    for (let n = 0; n < 1000; n++) expect(index.atPosition(4)?.label).toBe('Item and children');
    expect(spy).not.toHaveBeenCalled();
  });
  it('indexes ten thousand blocks once and keeps repeated scope queries bounded', () => {
    setup('<p>Long document paragraph</p>');
    const paragraph = editor.state.doc.child(0);
    const doc = editor.state.doc.type.create(
      null,
      Array.from({ length: 10_000 }, () => paragraph)
    );
    const rootWalk = jest.spyOn(doc, 'forEach');
    const childWalk = jest.spyOn(paragraph, 'forEach');
    const index = createFeedbackStructureIndex(doc);
    expect(rootWalk).toHaveBeenCalledTimes(1);
    expect(childWalk).toHaveBeenCalledTimes(10_000);
    rootWalk.mockClear();
    childWalk.mockClear();
    for (let count = 0; count < 1000; count++) index.choices(doc.content.size - 2);
    expect(rootWalk).not.toHaveBeenCalled();
    expect(childWalk).not.toHaveBeenCalled();
  });
});
