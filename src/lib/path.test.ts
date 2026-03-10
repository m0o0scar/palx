import { describe, it } from 'node:test';
import assert from 'node:assert';
import { getBaseName, getDirName, getFsBaseName, getFsDirName, normalizeFsPathForDisplay } from './path.ts';

describe('getBaseName', () => {
  it('should return the filename from a POSIX path', () => {
    assert.strictEqual(getBaseName('/path/to/file.txt'), 'file.txt');
  });

  it('should return the last directory name if path ends with a separator', () => {
    assert.strictEqual(getBaseName('/path/to/dir/'), 'dir');
  });

  it('should return the filename if it is already just a filename', () => {
    assert.strictEqual(getBaseName('file.txt'), 'file.txt');
  });

  it('should return empty string for empty input', () => {
    assert.strictEqual(getBaseName(''), '');
  });

  it('should handle root path', () => {
    assert.strictEqual(getBaseName('/'), '');
  });

  it('should return "." or ".." if they are the path', () => {
    assert.strictEqual(getBaseName('.'), '.');
    assert.strictEqual(getBaseName('..'), '..');
  });

  it('should return empty string for null/undefined (runtime check)', () => {
    // @ts-expect-error Testing runtime behavior
    assert.strictEqual(getBaseName(null), '');
    // @ts-expect-error Testing runtime behavior
    assert.strictEqual(getBaseName(undefined), '');
  });

  it('should support Windows drive paths', () => {
    assert.strictEqual(getBaseName('C:\\path\\to\\file.txt'), 'file.txt');
    assert.strictEqual(getBaseName('C:\\path\\to\\dir\\'), 'dir');
  });

  it('should support UNC paths', () => {
    assert.strictEqual(getBaseName('\\\\server\\share\\folder\\file.txt'), 'file.txt');
  });
});

describe('getDirName', () => {
  it('should return the directory name of a file path', () => {
    assert.equal(getDirName('/a/b/c.txt'), '/a/b');
  });

  it('should return the parent directory of a directory path', () => {
    assert.equal(getDirName('/a/b/c'), '/a/b');
  });

  it('should handle trailing slashes correctly', () => {
    assert.equal(getDirName('/a/b/c/'), '/a/b');
  });

  it('should return root for files in root', () => {
    assert.equal(getDirName('/file.txt'), '/');
  });

  it('should return . for files in current directory', () => {
    assert.equal(getDirName('file.txt'), '.');
  });

  it('should return . for relative paths without separators', () => {
    assert.equal(getDirName('dir'), '.');
  });

  it('should handle . and ..', () => {
    assert.equal(getDirName('.'), '.');
    assert.equal(getDirName('..'), '.');
  });

  it('should handle root path /', () => {
    assert.equal(getDirName('/'), '/');
  });

  it('should return empty string for empty input', () => {
    assert.equal(getDirName(''), '');
  });

  it('should support Windows drive paths', () => {
    assert.equal(getDirName('C:\\a\\b\\c.txt'), 'C:\\a\\b');
    assert.equal(getDirName('C:\\a\\b\\c\\'), 'C:\\a\\b');
  });

  it('should support Windows root drives and UNC paths', () => {
    assert.equal(getDirName('C:\\'), 'C:\\');
    assert.equal(getDirName('\\\\server\\share\\folder\\file.txt'), '\\\\server\\share\\folder');
  });
});

describe('explicit filesystem helpers', () => {
  it('normalizes Windows paths for display', () => {
    assert.strictEqual(normalizeFsPathForDisplay('C:/repo/subdir/file.ts'), 'C:\\repo\\subdir\\file.ts');
  });

  it('normalizes POSIX paths for display', () => {
    assert.strictEqual(normalizeFsPathForDisplay('/repo//subdir/file.ts'), '/repo/subdir/file.ts');
  });

  it('exposes fs helpers directly', () => {
    assert.strictEqual(getFsBaseName('C:\\repo\\file.ts'), 'file.ts');
    assert.strictEqual(getFsDirName('/repo/file.ts'), '/repo');
  });
});
