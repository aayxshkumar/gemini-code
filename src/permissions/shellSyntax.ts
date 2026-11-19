/**
 * Splits a command line into the simple commands it runs, by the rules of
 * the shell that will run it — bash/sh, PowerShell or cmd.exe — so that a
 * permission rule for `git status` is checked against every command in
 * `git status && rm -rf build`, not just the first word.
 *
 * What counts as another command:
 *   bash:  ;  &  &&  ||  |  |&  newline, ( ) and { } groups, $(…), `…`,
 *          <(…) >(…), and the bodies of if/while/until
 *   PowerShell: ;  |  &&  ||  newline, $(…) and @(…) subexpressions (also
 *          inside double quotes), { } script blocks, the & call operator
 *   cmd:   &  &&  ||  |  newline, ( ) groups; ^ escapes, "…" quotes
 *
 * Quoting is honoured, so `git commit -m "a && b"` is one command. Anything
 * this can't read with certainty — an unterminated quote, a heredoc, a
 * variable or substitution in the command name, for/case/function bodies —
 * is reported in `uncertain`, and a command line with anything uncertain is
 * never auto-approved (deny rules are still checked on what was read).
 */

export type ShellFlavour = "bash" | "powershell" | "cmd";

export interface SimpleCommand {
  /** Words after quote removal. words[0] is the command name. */
  words: string[];
  /** The command name came from an expansion ($X, $(...), %X%): unknown until it runs. */
  dynamicName?: boolean;
}

export interface ParsedLine {
  commands: SimpleCommand[];
  /** Files written by redirection (> file, >> file, 2> file …). */
  redirects: string[];
  /** Why the line can't be read with certainty; empty when it can. */
  uncertain: string[];
}

const empty = (): ParsedLine => ({ commands: [], redirects: [], uncertain: [] });

function merge(into: ParsedLine, from: ParsedLine): void {
  into.commands.push(...from.commands);
  into.redirects.push(...from.redirects);
  into.uncertain.push(...from.uncertain);
}

/** Finds the `)` closing a `(` at `start`, skipping quotes and nested parens. Returns its index or -1. */
function matchParen(s: string, start: number, flavour: ShellFlavour): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (flavour === "bash" && ch === "\\") {
      i++;
      continue;
    }
    if (flavour === "powershell" && ch === "`") {
      i++;
      continue;
    }
    if (ch === "'") {
      const end = s.indexOf("'", i + 1);
      if (end === -1) return -1;
      i = end;
      continue;
    }
    if (ch === '"') {
      for (i++; i < s.length && s[i] !== '"'; i++) {
        if ((flavour === "bash" && s[i] === "\\") || (flavour === "powershell" && s[i] === "`")) i++;
        else if (s[i] === "$" && s[i + 1] === "(") {
          const end = matchParen(s, i + 1, flavour);
          if (end === -1) return -1;
          i = end;
        }
      }
      if (i >= s.length) return -1;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function matchBrace(s: string, start: number): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === "`") {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = s.indexOf(ch, i + 1);
      if (end === -1) return -1;
      i = end;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------- bash / sh

const BASH_PREFIX_KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "fi", "done", "esac"]);
const BASH_OPAQUE_KEYWORDS = new Set(["for", "case", "select", "function", "[[", "((", "coproc"]);

export function parseBash(line: string): ParsedLine {
  const out = empty();
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let dynamic = false; // the current word contains an expansion
  let firstDynamic = false;
  let pendingRedirect = false;

  const endWord = () => {
    if (!inWord) return;
    if (pendingRedirect) {
      out.redirects.push(word);
      pendingRedirect = false;
    } else {
      if (words.length === 0) firstDynamic = dynamic;
      words.push(word);
    }
    word = "";
    inWord = false;
    dynamic = false;
  };
  const endCommand = () => {
    endWord();
    if (pendingRedirect) {
      out.uncertain.push("a redirection with no target");
      pendingRedirect = false;
    }
    // Leading keywords like `if` / `then` / `!` run the command after them.
    while (words.length && BASH_PREFIX_KEYWORDS.has(words[0])) {
      words.shift();
      firstDynamic = false;
    }
    // Leading assignments (FOO=1 cmd) are kept: decide.ts looks at them.
    if (words.length) {
      if (BASH_OPAQUE_KEYWORDS.has(words[0])) out.uncertain.push(`a \`${words[0]}\` construct`);
      out.commands.push({ words, ...(firstDynamic ? { dynamicName: true } : {}) });
    }
    words = [];
    firstDynamic = false;
  };
  const substitution = (inner: string) => {
    merge(out, parseBash(inner));
    dynamic = true;
    inWord = true;
  };

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];

    if (ch === "\\") {
      if (next === "\n") {
        i++;
        continue;
      }
      if (next === undefined) {
        out.uncertain.push("a trailing backslash");
        break;
      }
      word += next;
      inWord = true;
      i++;
      continue;
    }
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      if (end === -1) {
        out.uncertain.push("an unterminated ' quote");
        word += line.slice(i + 1);
        inWord = true;
        break;
      }
      word += line.slice(i + 1, end);
      inWord = true;
      i = end;
      continue;
    }
    if (ch === '"') {
      inWord = true;
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j++) {
        const c = line[j];
        if (c === "\\" && j + 1 < line.length && '"\\$`\n'.includes(line[j + 1])) {
          if (line[j + 1] !== "\n") word += line[j + 1];
          j++;
        } else if (c === "$" && line[j + 1] === "(") {
          const end = matchParen(line, j + 1, "bash");
          if (end === -1) {
            out.uncertain.push("an unterminated $( in quotes");
            j = line.length;
            break;
          }
          if (line[j + 2] !== "(") substitution(line.slice(j + 2, end));
          j = end;
        } else if (c === "`") {
          const end = line.indexOf("`", j + 1);
          if (end === -1) {
            out.uncertain.push("an unterminated ` in quotes");
            j = line.length;
            break;
          }
          substitution(line.slice(j + 1, end));
          j = end;
        } else {
          if (c === "$") dynamic = true;
          word += c;
        }
      }
      if (j >= line.length) {
        out.uncertain.push('an unterminated " quote');
        break;
      }
      i = j;
      continue;
    }
    if (ch === "$" && next === "(") {
      const end = matchParen(line, i + 1, "bash");
      if (end === -1) {
        out.uncertain.push("an unterminated $(");
        break;
      }
      if (line[i + 2] === "(") {
        // $(( arithmetic )) — no commands, but it can expand.
        dynamic = true;
        inWord = true;
      } else substitution(line.slice(i + 2, end));
      i = end;
      continue;
    }
    if (ch === "`") {
      const end = line.indexOf("`", i + 1);
      if (end === -1) {
        out.uncertain.push("an unterminated `");
        break;
      }
      substitution(line.slice(i + 1, end));
      i = end;
      continue;
    }
    if ((ch === "<" || ch === ">") && next === "(") {
      endWord();
      const end = matchParen(line, i + 1, "bash");
      if (end === -1) {
        out.uncertain.push("an unterminated process substitution");
        break;
      }
      merge(out, parseBash(line.slice(i + 2, end)));
      i = end;
      continue;
    }
    if (ch === "$") {
      dynamic = true;
      word += ch;
      inWord = true;
      continue;
    }
    if (ch === "#" && !inWord) {
      const nl = line.indexOf("\n", i);
      if (nl === -1) break;
      i = nl - 1;
      continue;
    }
    if (ch === " " || ch === "\t") {
      endWord();
      continue;
    }
    if (ch === "\n" || ch === ";" || ch === "&" || ch === "|" || ch === "(" || ch === ")") {
      // `2>&1`, `>&2` and `&>` are redirections, not separators.
      if (ch === "&" && next === ">") {
        endWord();
        pendingRedirect = true;
        i += line[i + 2] === ">" ? 2 : 1;
        continue;
      }
      endCommand();
      if ((ch === "&" && next === "&") || (ch === "|" && (next === "|" || next === "&")) || (ch === ";" && next === ";")) i++;
      continue;
    }
    if (ch === ">" || ch === "<") {
      // The digits before (2>) belong to the operator, not to a word.
      if (/^\d+$/.test(word) && inWord) {
        word = "";
        inWord = false;
      } else endWord();
      if (ch === "<" && next === "<") {
        if (line[i + 2] === "<") {
          i += 2; // <<< here-string: the next word is input, not a file
          continue;
        }
        out.uncertain.push("a heredoc");
        i++;
        continue;
      }
      if (ch === ">" && next === "&") {
        // >&2, 2>&1: a descriptor, not a file — skip it.
        i++;
        while (/[\d-]/.test(line[i + 1] ?? "")) i++;
        continue;
      }
      if (ch === ">") {
        pendingRedirect = true;
        if (next === ">" || next === "|") i++;
      } else {
        // < file: reads only.
        i += next === ">" ? 1 : 0;
        if (next === ">") pendingRedirect = true;
        else {
          let j = i + 1;
          while (line[j] === " ") j++;
          while (j < line.length && !/[\s;&|()<>]/.test(line[j])) j++;
          i = j - 1;
        }
      }
      continue;
    }
    word += ch;
    inWord = true;
  }
  endCommand();
  return out;
}

// --------------------------------------------------------------- PowerShell

export function parsePowerShell(line: string): ParsedLine {
  const out = empty();
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let dynamic = false;
  let firstDynamic = false;
  let pendingRedirect = false;

  const endWord = () => {
    if (!inWord) return;
    if (pendingRedirect) {
      out.redirects.push(word);
      pendingRedirect = false;
    } else {
      if (words.length === 0) firstDynamic = dynamic;
      words.push(word);
    }
    word = "";
    inWord = false;
    dynamic = false;
  };
  const endCommand = () => {
    endWord();
    // `& "C:\tool.exe" args` — the call operator runs the next word.
    if (words[0] === "&") {
      words.shift();
    }
    if (words[0] === ".") {
      out.uncertain.push("dot-sourcing a script");
    }
    if (words.length) out.commands.push({ words, ...(firstDynamic ? { dynamicName: true } : {}) });
    words = [];
    firstDynamic = false;
  };
  const sub = (inner: string) => {
    merge(out, parsePowerShell(inner));
    dynamic = true;
    inWord = true;
  };

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === "`") {
      if (next === "\n") {
        i++;
        continue;
      }
      if (next === undefined) {
        out.uncertain.push("a trailing backtick");
        break;
      }
      word += next;
      inWord = true;
      i++;
      continue;
    }
    if (ch === "<" && next === "#") {
      const end = line.indexOf("#>", i + 2);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    if (ch === "#" && !inWord) {
      const nl = line.indexOf("\n", i);
      if (nl === -1) break;
      i = nl - 1;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      for (; j < line.length; j++) {
        if (line[j] === "'" && line[j + 1] === "'") {
          word += "'";
          j++;
        } else if (line[j] === "'") break;
        else word += line[j];
      }
      if (j >= line.length) {
        out.uncertain.push("an unterminated ' quote");
        break;
      }
      inWord = true;
      i = j;
      continue;
    }
    if (ch === '"') {
      inWord = true;
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j++) {
        const c = line[j];
        if (c === "`") {
          j++;
          word += line[j] ?? "";
        } else if (c === "$" && line[j + 1] === "(") {
          const end = matchParen(line, j + 1, "powershell");
          if (end === -1) {
            out.uncertain.push("an unterminated $( in quotes");
            j = line.length;
            break;
          }
          sub(line.slice(j + 2, end));
          j = end;
        } else {
          if (c === "$") dynamic = true;
          word += c;
        }
      }
      if (j >= line.length) {
        out.uncertain.push('an unterminated " quote');
        break;
      }
      i = j;
      continue;
    }
    if ((ch === "$" || ch === "@") && next === "(") {
      const end = matchParen(line, i + 1, "powershell");
      if (end === -1) {
        out.uncertain.push(`an unterminated ${ch}(`);
        break;
      }
      sub(line.slice(i + 2, end));
      i = end;
      continue;
    }
    if (ch === "(") {
      // A parenthesised expression runs whatever pipeline is inside.
      const end = matchParen(line, i, "powershell");
      if (end === -1) {
        out.uncertain.push("an unterminated (");
        break;
      }
      sub(line.slice(i + 1, end));
      i = end;
      continue;
    }
    if (ch === "{") {
      const end = matchBrace(line, i);
      if (end === -1) {
        out.uncertain.push("an unterminated {");
        break;
      }
      // A script block: its commands may run (ForEach-Object { … }).
      merge(out, parsePowerShell(line.slice(i + 1, end)));
      word += "{…}";
      inWord = true;
      i = end;
      continue;
    }
    if (ch === "$") {
      dynamic = true;
      word += ch;
      inWord = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      endWord();
      continue;
    }
    if (ch === "\n" || ch === ";" || ch === "|" || (ch === "&" && next === "&")) {
      endCommand();
      if ((ch === "|" && next === "|") || (ch === "&" && next === "&")) i++;
      continue;
    }
    if (ch === "&" && !inWord) {
      // The call operator: `& cmd`. Treated as a word so endCommand sees it.
      endWord();
      words.push("&");
      continue;
    }
    if (ch === ">" || (/[\d*]/.test(ch) && next === ">" && !inWord)) {
      endWord();
      let j = ch === ">" ? i : i + 1;
      if (line[j + 1] === ">") j++;
      if (line[j + 1] === "&") {
        // 2>&1: a stream merge, not a file.
        j += 2;
        i = j;
        continue;
      }
      pendingRedirect = true;
      i = j;
      continue;
    }
    word += ch;
    inWord = true;
  }
  endCommand();
  return out;
}

// --------------------------------------------------------------------- cmd

export function parseCmd(line: string): ParsedLine {
  const out = empty();
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let dynamic = false;
  let firstDynamic = false;
  let pendingRedirect = false;
  let quoted = false;

  const endWord = () => {
    if (!inWord) return;
    if (pendingRedirect) {
      out.redirects.push(word);
      pendingRedirect = false;
    } else {
      if (words.length === 0) firstDynamic = dynamic;
      words.push(word);
    }
    word = "";
    inWord = false;
    dynamic = false;
  };
  const endCommand = () => {
    endWord();
    if (words[0]?.startsWith("@")) words[0] = words[0].slice(1) || (words.shift(), words[0] ?? "");
    if (words.length && words[0]) out.commands.push({ words, ...(firstDynamic ? { dynamicName: true } : {}) });
    words = [];
    firstDynamic = false;
  };

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (quoted) {
      if (ch === '"') quoted = false;
      else {
        if (ch === "%" || ch === "!") dynamic = true;
        word += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      inWord = true;
      continue;
    }
    if (ch === "^") {
      if (next === "\n" || next === "\r") {
        i += next === "\r" && line[i + 2] === "\n" ? 2 : 1;
        continue;
      }
      if (next === undefined) break;
      word += next;
      inWord = true;
      i++;
      continue;
    }
    if (ch === "%" || ch === "!") {
      // %VAR% / !VAR! expand before the line runs.
      if (/^%[^%\s]+%/.test(line.slice(i)) || /^![^!\s]+!/.test(line.slice(i))) dynamic = true;
      word += ch;
      inWord = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "," || ch === "=" && !inWord) {
      endWord();
      continue;
    }
    if (ch === "\n" || ch === "&" || ch === "|" || ch === "(" || ch === ")") {
      endCommand();
      if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) i++;
      continue;
    }
    if (ch === ">" || ch === "<" || (/\d/.test(ch) && next === ">" && !inWord)) {
      endWord();
      let j = /\d/.test(ch) ? i + 1 : i;
      if (line[j] === "<") {
        // < file: input only; skip the file word.
        let k = j + 1;
        while (line[k] === " ") k++;
        while (k < line.length && !/[\s&|<>()]/.test(line[k])) k++;
        i = k - 1;
        continue;
      }
      if (line[j + 1] === ">") j++;
      if (line[j + 1] === "&") {
        j += 2;
        i = j;
        continue;
      }
      pendingRedirect = true;
      i = j;
      continue;
    }
    word += ch;
    inWord = true;
  }
  if (quoted) out.uncertain.push('an unterminated " quote');
  endCommand();
  return out;
}

export function parseLine(line: string, flavour: ShellFlavour): ParsedLine {
  return flavour === "powershell" ? parsePowerShell(line) : flavour === "cmd" ? parseCmd(line) : parseBash(line);
}
