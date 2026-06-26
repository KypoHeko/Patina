// Minimal .gitignore support for the directory scan.
//
// Implements the common subset: comments (#), blank lines, negation (!),
// directory-only patterns (trailing /), root-anchored patterns (leading /),
// and globs (*, ?, **). Last matching rule wins, as in git. Paths are matched
// relative to the .gitignore's directory, using "/" separators.
//
// Not covered (rare): escaped "#"/"!", character ranges [a-z]. Good enough to
// prune build dirs like target/, node_modules/, dist, *.log, /build, etc.

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?'; // **/ — any number of leading directories
        } else {
          re += '.*'; // ** — across directories
        }
      } else {
        re += '[^/]*'; // * — within a path segment
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

/** Compile .gitignore text into a list of rules. */
export function compileGitignore(text) {
  const rules = [];
  for (let line of String(text || '').split(/\r?\n/)) {
    line = line.replace(/\s+$/, ''); // trailing whitespace
    if (!line || line.startsWith('#')) continue;

    let negate = false;
    if (line.startsWith('!')) {
      negate = true;
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    let anchored = false;
    if (line.startsWith('/')) {
      anchored = true;
      line = line.slice(1);
    }
    if (!line) continue;

    const hasSlash = line.includes('/');
    // A pattern with no slash matches the basename at any depth; otherwise it is
    // anchored to the .gitignore directory and matched against the full rel path.
    rules.push({ re: globToRegExp(line), negate, dirOnly, basename: !hasSlash && !anchored });
  }
  return rules;
}

/**
 * Build a matcher from rules.
 * @returns {(relPath:string, isDir:boolean)=>boolean}
 */
export function makeIgnoreMatcher(rules) {
  return (relPath, isDir) => {
    const name = relPath.slice(relPath.lastIndexOf('/') + 1);
    let ignored = false;
    for (const r of rules) {
      if (r.dirOnly && !isDir) continue;
      const target = r.basename ? name : relPath;
      if (r.re.test(target)) ignored = !r.negate;
    }
    return ignored;
  };
}

/** Convenience: text → matcher. */
export function gitignoreMatcher(text) {
  return makeIgnoreMatcher(compileGitignore(text));
}
