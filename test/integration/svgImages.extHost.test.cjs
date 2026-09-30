/**
 * SVG image source integrity at the real VS Code/webview boundary.
 *
 * The browser fixture verifies visible geometry. This suite verifies that the
 * shipped editor and its live Feedback snapshot preserve SVG references and HTML
 * dimensions through actual custom-editor splits, save, disposal, and reopening.
 * Encoded filesystem references cover literal delimiters through the real host.
 * Insertion generation is covered by imageDestinationEncoding.test.ts because
 * native clipboard focus is not reliable through the public Extension Host API.
 * Every document, asset, and draft is synthetic and removed after the test.
 */
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const vscode = require('vscode');

const CUSTOM_EDITOR_VIEW_TYPE = 'markdownForHumans.editor';

async function waitFor(predicate, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function imageTabs(uri) {
  return vscode.window.tabGroups.all
    .flatMap(group => group.tabs)
    .filter(
      tab =>
        tab.input instanceof vscode.TabInputCustom &&
        tab.input.viewType === CUSTOM_EDITOR_VIEW_TYPE &&
        tab.input.uri.toString() === uri.toString()
    );
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function openImageEditor(uri, viewColumn = vscode.ViewColumn.One) {
  await vscode.commands.executeCommand('vscode.openWith', uri, CUSTOM_EDITOR_VIEW_TYPE, {
    viewColumn,
    preview: false,
    preserveFocus: false,
  });
}

async function verifyLiveFeedback(sourceUri, feedbackRoot, source, errors) {
  // Public commands now await the generation-validated controller readiness
  // signal. Exercise immediate startup, without a machine-dependent sleep.
  assert.equal(
    await vscode.commands.executeCommand('markdownForHumans.feedback.start'),
    true,
    'Feedback command must reach the ready, active SVG editor'
  );
  const feedbackFile = await waitFor(() => {
    assert.equal(errors.length, 0, errors.join(' | '));
    if (!fs.existsSync(feedbackRoot)) return undefined;
    for (const entry of fs.readdirSync(feedbackRoot)) {
      const candidate = path.join(feedbackRoot, entry, 'feedback.md');
      if (fs.existsSync(candidate)) return candidate;
    }
    return undefined;
  }, 'live SVG Feedback snapshot');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(errors.length, 0, errors.join(' | '));
  assert.ok(
    fs.readFileSync(feedbackFile, 'utf8').includes(sha256(Buffer.from(source))),
    'Feedback snapshot must bind the unchanged source bytes'
  );
  assert.equal((await vscode.workspace.openTextDocument(sourceUri)).getText(), source);
}

suite('SVG image integrity (Ext Host)', () => {
  suiteSetup(async function () {
    this.timeout(60_000);
    const extension = vscode.extensions.getExtension('concretio.markdown-for-humans');
    assert.ok(extension, 'Expected the development extension');
    await extension.activate();
  });

  test('preserves SVG files and sized image source through splits, reopen, and live Feedback', async function () {
    this.timeout(120_000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, 'Expected integration fixture workspace');
    const temporary = fs.mkdtempSync(path.join(workspaceFolder.uri.fsPath, '.svg-host-'));
    const feedbackRoot = path.join(
      workspaceFolder.uri.fsPath,
      '.md4h',
      'feedback',
      path.basename(temporary)
    );
    const sourcePath = path.join(temporary, 'svg-regression.md');
    const sourceUri = vscode.Uri.file(sourcePath);
    const assets = path.join(temporary, 'assets');
    fs.mkdirSync(assets);
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 560"><view id="detail" viewBox="0 0 640 280"/><rect width="1280" height="560" fill="#266cd3"/><text x="30" y="90">SVG source remains vector</text></svg>\n';
    const icon =
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#266cd3"/></svg>\n';
    const imagePaths = [
      path.join(assets, 'viewbox.svg'),
      path.join(assets, 'diagram # view.svg'),
      path.join(assets, 'icon.svg'),
    ];
    fs.writeFileSync(imagePaths[0], svg);
    fs.writeFileSync(imagePaths[1], svg);
    fs.writeFileSync(imagePaths[2], icon);
    const source = [
      '# SVG host regression',
      '',
      '![viewBox-only SVG](assets/viewbox.svg)',
      '',
      '![Marp text remains alt text w:1000](assets/viewbox.svg)',
      '',
      '![Encoded filename and SVG view](assets/diagram%20%23%20view.svg#detail)',
      '',
      '<img src="assets/viewbox.svg" alt="Sized diagram" width="480" height="210" />',
      '',
      // R1: an opening HTML image must not swallow later Markdown into a raw
      // HTML block when the first inline SVG has display dimensions.
      '<img src="assets/viewbox.svg" alt="Sized first inline SVG" width="480" /> ![Following Markdown image](assets/icon.svg) **bold** [link](https://example.com) `code`',
      '',
      // Use the repaired serializer's backslash break. Two trailing spaces after
      // an otherwise standalone HTML tag intentionally remain a raw HTML block.
      '<img src="assets/viewbox.svg" alt="Sized first line" width="320" />\\',
      '![Following image after a hard break](assets/icon.svg) **formatted continuation**',
      '',
      '- <img src="assets/icon.svg" alt="Sized first list SVG" width="24" /> ![Following list image](assets/icon.svg) **bold list text**',
      '',
      '<img',
      ' src="assets/viewbox.svg"',
      ' alt="Multiline source" width="320" />',
      '',
      '- Inline SVG <img src="assets/icon.svg" alt="Icon" width="24" /> in a list.',
      '',
      '| Image | Description |',
      '| --- | --- |',
      '| <img src="assets/viewbox.svg" alt="Table diagram" width="240" /> | Vector |',
      '| <img src="assets/icon.svg" alt="Sized first table SVG" width="24" /> ![Following table image](assets/icon.svg) | **Formatted cell** |',
      '',
      'A final paragraph keeps the document boundary explicit.',
      '',
    ].join('\n');
    fs.writeFileSync(sourcePath, source);
    const originals = new Map(
      [sourcePath, ...imagePaths].map(file => [file, sha256(fs.readFileSync(file))])
    );
    const errors = [];
    const originalShowError = vscode.window.showErrorMessage;
    vscode.window.showErrorMessage = async message => {
      errors.push(String(message));
      return undefined;
    };

    try {
      await vscode.commands.executeCommand('vscode.openWith', sourceUri, CUSTOM_EDITOR_VIEW_TYPE, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
      });
      await waitFor(() => imageTabs(sourceUri).length === 1, 'SVG custom editor');
      await vscode.commands.executeCommand('vscode.openWith', sourceUri, CUSTOM_EDITOR_VIEW_TYPE, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: false,
      });
      await waitFor(() => imageTabs(sourceUri).length === 2, 'SVG split editors');
      assert.equal(await vscode.window.tabGroups.close(imageTabs(sourceUri)[0]), true);
      await waitFor(() => imageTabs(sourceUri).length === 1, 'surviving SVG editor');
      const document = await vscode.workspace.openTextDocument(sourceUri);
      assert.equal(await document.save(), true);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('vscode.openWith', sourceUri, CUSTOM_EDITOR_VIEW_TYPE, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
      });
      await waitFor(() => imageTabs(sourceUri).length === 1, 'reopened SVG editor');

      await verifyLiveFeedback(sourceUri, feedbackRoot, source, errors);
      for (const [file, originalHash] of originals) {
        assert.equal(
          sha256(fs.readFileSync(file)),
          originalHash,
          `Editor changed source or SVG bytes: ${path.basename(file)}`
        );
      }
      assert.equal((await vscode.workspace.openTextDocument(sourceUri)).getText(), source);
    } finally {
      vscode.window.showErrorMessage = originalShowError;
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      fs.rmSync(feedbackRoot, { recursive: true, force: true });
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  test('resolves encoded literal filename and directory delimiters through save, reopen, and live Feedback', async function () {
    this.timeout(120_000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, 'Expected integration fixture workspace');
    const temporary = fs.mkdtempSync(path.join(workspaceFolder.uri.fsPath, '.svg-paths-'));
    const feedbackRoot = path.join(
      workspaceFolder.uri.fsPath,
      '.md4h',
      'feedback',
      path.basename(temporary)
    );
    const sourcePath = path.join(temporary, 'encoded-paths.md');
    const sourceUri = vscode.Uri.file(sourcePath);
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"><rect width="120" height="60" fill="#266cd3"/></svg>\n'
    );
    const cases = [
      ['assets # diagram', 'literal # view.svg'],
      ['assets %23 literal', 'literal %25 %23.svg'],
      ['assets space ü', 'diagram ü.svg'],
    ];
    // Windows disallows literal question marks in filenames. Keep #, %, spaces
    // and Unicode cross-platform, and test ? on filesystems that support it.
    if (process.platform !== 'win32') cases.push(['assets ? query', 'literal ? view.svg']);
    const assets = cases.map(([directory, filename]) => {
      const asset = path.join(temporary, directory, filename);
      fs.mkdirSync(path.dirname(asset), { recursive: true });
      fs.writeFileSync(asset, svg);
      return asset;
    });
    const destinations = assets.map(asset => {
      const relative = path.relative(temporary, asset).split(path.sep).join('/');
      return './' + relative.split('/').map(encodeURIComponent).join('/');
    });
    const source = [
      '# Encoded SVG filesystem paths',
      '',
      ...destinations.flatMap((destination, index) => [`![Image ${index}](${destination})`, '']),
    ].join('\n');
    fs.writeFileSync(sourcePath, source);
    const errors = [];
    const originalShowError = vscode.window.showErrorMessage;
    vscode.window.showErrorMessage = async message => {
      errors.push(String(message));
      return undefined;
    };

    try {
      await openImageEditor(sourceUri);
      await waitFor(() => imageTabs(sourceUri).length === 1, 'encoded SVG editor');
      const document = await vscode.workspace.openTextDocument(sourceUri);
      for (const [index, asset] of assets.entries()) {
        const resolved = new URL(destinations[index], pathToFileURL(sourcePath));
        assert.equal(resolved.hash, '', 'Literal # must not become an SVG fragment');
        assert.equal(resolved.search, '', 'Literal ? must not become a URL query');
        assert.equal(fileURLToPath(resolved), asset, 'Destination must decode exactly once');
        assert.equal(
          sha256(await vscode.workspace.fs.readFile(vscode.Uri.parse(resolved.href))),
          sha256(svg),
          'The encoded destination must resolve to the original SVG bytes'
        );
      }
      assert.equal(await document.save(), true);
      assert.equal(document.getText(), source);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await openImageEditor(sourceUri);
      await waitFor(() => imageTabs(sourceUri).length === 1, 'reopened encoded SVG images');
      await verifyLiveFeedback(sourceUri, feedbackRoot, source, errors);
      assert.equal(fs.readFileSync(sourcePath, 'utf8'), source);
      for (const asset of assets) assert.equal(sha256(fs.readFileSync(asset)), sha256(svg));
    } finally {
      vscode.window.showErrorMessage = originalShowError;
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      fs.rmSync(feedbackRoot, { recursive: true, force: true });
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});
