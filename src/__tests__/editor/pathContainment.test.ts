/**
 * Path-Containment / Path-Traversal Defense Tests
 *
 * These tests guard the security boundary used by image rename, resize, and
 * file-link handlers. The handlers receive paths from messages whose ultimate
 * source is the markdown content the user opened — which can be hostile.
 *
 * Without containment checks, a malicious markdown file with
 * `![pet](../../../../etc/passwd)` (or any traversal payload) lets a single
 * user click ("Rename image…", "Resize image…") rename / overwrite files
 * completely outside the workspace. See SECURITY review §H1, §H2.
 *
 * Contract:
 *   isPathContainedWithin(target, root)
 *     - returns TRUE iff `target` is `root` itself or strictly inside `root`
 *     - returns FALSE for any path that escapes `root` via `..`, absolute
 *       paths to other roots, symlink-style "looks-similar" prefixes
 *       (e.g. /workspace-evil for root /workspace), or by drive-letter on Win
 *     - operates on already-resolved absolute paths (caller is responsible
 *       for path.resolve() before calling)
 */

// Default import: the real module object, so `jest.spyOn` sees the provider's calls.
import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  isPathContainedWithin,
  resolveContainedImageSource,
} from '../../editor/MarkdownEditorProvider';

describe('isPathContainedWithin (path-traversal defense)', () => {
  const ROOT = path.resolve('/tmp/workspace');

  describe('legitimate paths inside the root', () => {
    it('accepts the root itself', () => {
      expect(isPathContainedWithin(ROOT, ROOT)).toBe(true);
    });

    it('accepts a direct child file', () => {
      expect(isPathContainedWithin(path.join(ROOT, 'image.png'), ROOT)).toBe(true);
    });

    it('accepts a deeply nested file', () => {
      expect(isPathContainedWithin(path.join(ROOT, 'a', 'b', 'c', 'image.png'), ROOT)).toBe(true);
    });

    it('accepts a path with redundant segments that resolve inside', () => {
      const wobbly = path.resolve(ROOT, 'a', '..', 'b', 'image.png');
      expect(isPathContainedWithin(wobbly, ROOT)).toBe(true);
    });
  });

  describe('attack: traversal via "../" sequences', () => {
    it('rejects "../etc/passwd" attack', () => {
      const attack = path.resolve(ROOT, '..', '..', '..', 'etc', 'passwd');
      expect(isPathContainedWithin(attack, ROOT)).toBe(false);
    });

    it('rejects an absolute path outside the root', () => {
      expect(isPathContainedWithin('/etc/passwd', ROOT)).toBe(false);
    });

    it('rejects a path under the user home', () => {
      expect(isPathContainedWithin('/Users/victim/.ssh/id_ed25519', ROOT)).toBe(false);
    });

    it('rejects ".." resolving to the parent of root', () => {
      expect(isPathContainedWithin(path.dirname(ROOT), ROOT)).toBe(false);
    });
  });

  describe('attack: prefix-confusion (the classic startsWith bug)', () => {
    /**
     * The naive check `target.startsWith(root)` mis-classifies sibling
     * directories whose names *begin with* the root's name. This is the
     * bug we are explicitly defending against.
     */
    it('rejects a sibling whose name shares the root prefix', () => {
      // /tmp/workspace-evil starts with /tmp/workspace, but is NOT inside it
      const sibling = path.resolve('/tmp/workspace-evil/file.png');
      expect(isPathContainedWithin(sibling, ROOT)).toBe(false);
    });

    it('rejects a sibling whose name extends the root by characters', () => {
      const sibling = path.resolve('/tmp/workspaceX/file.png');
      expect(isPathContainedWithin(sibling, ROOT)).toBe(false);
    });
  });

  describe('inputs', () => {
    it('returns false for empty target', () => {
      expect(isPathContainedWithin('', ROOT)).toBe(false);
    });

    it('returns false for empty root', () => {
      expect(isPathContainedWithin('/tmp/workspace/x', '')).toBe(false);
    });
  });
});

// Creating symlinks on Windows needs Developer Mode or admin rights.
const describeWithSymlinks = process.platform === 'win32' ? describe.skip : describe;

describeWithSymlinks('resolveContainedImageSource follows symlinks (02-F2)', () => {
  // A cloned repo can commit symlinks. The webview loader and Chrome both follow
  // them, so a lexically contained path must also be contained once resolved.
  let temporary: string;
  let workspace: string;
  let docs: string;
  let roots: string[];

  beforeAll(() => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'md4h-symlink-'));
    workspace = path.join(temporary, 'ws');
    docs = path.join(workspace, 'docs');
    const outside = path.join(temporary, 'outside');
    fs.mkdirSync(docs, { recursive: true });
    fs.mkdirSync(path.join(workspace, 'shared'));
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.png'), 'secret');
    fs.writeFileSync(path.join(workspace, 'shared', 'logo.png'), 'logo');
    fs.writeFileSync(path.join(docs, 'plain.png'), 'plain');
    fs.symlinkSync(outside, path.join(docs, 'link'), 'dir');
    fs.symlinkSync(path.join(outside, 'secret.png'), path.join(docs, 'alias.png'), 'file');
    fs.symlinkSync(path.join('..', 'shared'), path.join(docs, 'assets'), 'dir');
    fs.symlinkSync(workspace, path.join(temporary, 'ws-link'), 'dir');
    roots = [workspace, docs];
  });

  afterAll(() => {
    fs.rmSync(temporary, { recursive: true, force: true });
  });

  it('refuses a file reached through a directory symlink that leaves every root', () => {
    expect(resolveContainedImageSource('link/secret.png', docs, roots)).toBeUndefined();
  });

  it('refuses a file symlink whose target is outside every root', () => {
    expect(resolveContainedImageSource('alias.png', docs, roots)).toBeUndefined();
  });

  it('accepts an in-root symlink that resolves inside an allowed root, at its lexical path', () => {
    expect(resolveContainedImageSource('assets/logo.png?v=2', docs, roots)).toEqual({
      absolutePath: path.join(docs, 'assets', 'logo.png'),
      suffix: '?v=2',
    });
  });

  it('accepts files when the allowed root itself is reached through a symlink', () => {
    const linkedDocs = path.join(temporary, 'ws-link', 'docs');
    const linkedRoots = [path.join(temporary, 'ws-link'), linkedDocs];
    expect(resolveContainedImageSource('plain.png', linkedDocs, linkedRoots)).toEqual({
      absolutePath: path.join(linkedDocs, 'plain.png'),
      suffix: '',
    });
    expect(resolveContainedImageSource('link/secret.png', linkedDocs, linkedRoots)).toBeUndefined();
  });

  it('keeps the lexical decision for a contained file that does not exist yet', () => {
    expect(resolveContainedImageSource('new.png', docs, roots)).toEqual({
      absolutePath: path.join(docs, 'new.png'),
      suffix: '',
    });
  });
});

describe('resolveContainedImageSource refuses lexically before resolving symlinks (02-R3)', () => {
  // realpath on a Windows UNC path (`\\host\share`) is an SMB lookup that can leak
  // credentials, so a lexically refused source must never reach it.
  afterEach(() => jest.restoreAllMocks());

  it.each(['../../../../etc/hosts', '/etc/hosts', '//host/share/x.png'])(
    'never resolves the real path of %s',
    source => {
      const realpathSync = jest.spyOn(fs, 'realpathSync');
      const root = path.resolve('/tmp/workspace');
      expect(resolveContainedImageSource(source, root, [root])).toBeUndefined();
      expect(realpathSync).not.toHaveBeenCalled();
    }
  );
});
