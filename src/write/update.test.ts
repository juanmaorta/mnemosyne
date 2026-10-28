// src/write/update.test.ts
//
// `update` is the ONLY supported way to change a note: a compare-and-swap on the
// exact bytes on disk. These tests pin the two things that make that claim true —
// identity is never altered, and a refused update leaves the original byte for
// byte, with no temporary file left behind.
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

/**
 * A seam for the one failure that cannot be provoked from outside: the rename
 * that installs the new note (EXDEV/EIO/ENOSPC on a synced store). It is the
 * only point at which the temporary file already exists, so it is the only way
 * to exercise the cleanup branch. Everything else delegates to the real fs.
 *
 * `durability` records the fsync/rename calls in order, because durability is
 * precisely an ordering property: a crash cannot be staged, but the sequence
 * that makes the swap survive one can be read off here. `fdPaths` only exists
 * to name the file behind an fsync'd descriptor.
 */
const fsHook = vi.hoisted(() => ({
  failRename: false,
  lastRenamedFrom: "",
  vanishOnStat: "",
  durability: [] as string[],
  fdPaths: new Map<number, string>(),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: ((path: unknown, ...rest: unknown[]) => {
      const fd = (actual.openSync as (...a: unknown[]) => number)(path, ...rest);
      fsHook.fdPaths.set(fd, String(path));
      return fd;
    }) as unknown as typeof actual.openSync,
    fsyncSync: (fd: number): void => {
      fsHook.durability.push(`fsync:${fsHook.fdPaths.get(fd) ?? fd}`);
      actual.fsyncSync(fd);
    },
    renameSync: (from: string, to: string): void => {
      fsHook.lastRenamedFrom = from;
      fsHook.durability.push(`rename:${from}`);
      if (fsHook.failRename) throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
      actual.renameSync(from, to);
    },
    // Deletes the note the instant it is stat'ed — i.e. inside the lock, after
    // the walk already located it. One shot, so only that stat loses the race.
    lstatSync: ((path: unknown, ...rest: unknown[]) => {
      if (fsHook.vanishOnStat && path === fsHook.vanishOnStat) {
        fsHook.vanishOnStat = "";
        actual.unlinkSync(path as string);
      }
      return (actual.lstatSync as (...a: unknown[]) => unknown)(path, ...rest);
    }) as unknown as typeof actual.lstatSync,
  };
});
import { parseFrontmatter } from "../frontmatter.js";
import { NotOwnerError, ScopeUnresolvedError, SecretDetectedError } from "./validation.js";
import {
  DuplicateSlugError,
  IdentityMismatchError,
  NoChangesError,
  NoteNotFoundError,
  NotEditableError,
  NotRegularFileError,
  RevisionMismatchError,
  UnknownSupersederError,
  updateNote,
} from "./update.js";

interface Fixture {
  root: string;
  home: string;
}

function store(owns: string[] = ["personal"], scopemap?: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), "mneme-update-"));
  mkdirSync(join(root, "personal"), { recursive: true });
  writeFileSync(join(root, ".owner"), JSON.stringify({ owns }));
  if (scopemap) writeFileSync(join(root, ".scopemap"), scopemap);
  return { root, home: mkdtempSync(join(tmpdir(), "mneme-home-")) };
}

/** A note written straight to disk — the state `update` has to find for itself. */
function note(
  root: string,
  scope: string,
  filename: string,
  frontmatter: string[],
  body = "cuerpo original\n",
): string {
  const dir = join(root, scope);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  writeFileSync(path, `---\n${frontmatter.join("\n")}\n---\n${body}`);
  return path;
}

const FULL = [
  "name: fermentor",
  "description: como hacer yogur",
  "scope: personal",
  "created: 2026-06-01T10:00:00",
  "importance: 7",
  "links:",
  "  - fermentacion",
  "sources:",
  "  - receta-abuela",
  "type: reference",
];

function revisionOnDisk(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Hidden temporaries are the failure mode this whole design exists to avoid. */
function leftovers(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.includes(".tmp-"));
}

describe("updateNote", () => {
  test("update_replaces_the_body_and_preserves_every_identity_field", () => {
    const { root, home } = store();
    const path = note(root, "personal", "fermentor.md", FULL);
    const before = revisionOnDisk(path);

    const res = updateNote({ root, cwd: "/anywhere", home }, {
      slug: "fermentor",
      scope: "personal",
      ifMatch: before,
      content: "cuerpo nuevo\ncon dos lineas\n",
    });

    expect(res).toMatchObject({ path, scope: "personal", slug: "fermentor" });
    const doc = parseFrontmatter(readFileSync(path, "utf8"));
    expect(doc.data).toEqual({
      name: "fermentor",
      description: "como hacer yogur",
      scope: "personal",
      created: "2026-06-01T10:00:00",
      importance: 7,
      links: ["fermentacion"],
      sources: ["receta-abuela"],
      type: "reference",
    });
    expect(doc.body).toBe("cuerpo nuevo\ncon dos lineas\n");
    // The returned revision describes the bytes that are actually on disk now.
    expect(res.revision).toBe(revisionOnDisk(path));
    expect(res.revision).not.toBe(before);
    expect(leftovers(join(root, "personal"))).toEqual([]);
  });

  test("update_changes_description_and_importance_without_touching_the_body", () => {
    const { root, home } = store();
    const path = note(root, "personal", "fermentor.md", FULL, "cuerpo intacto\n");

    updateNote({ root, cwd: "/anywhere", home }, {
      slug: "fermentor",
      scope: "personal",
      ifMatch: revisionOnDisk(path),
      description: "receta revisada",
      importance: 3,
    });

    const doc = parseFrontmatter(readFileSync(path, "utf8"));
    expect(doc.data.description).toBe("receta revisada");
    expect(doc.data.importance).toBe(3);
    expect(doc.data.created).toBe("2026-06-01T10:00:00");
    expect(doc.body).toBe("cuerpo intacto\n");
  });

  test("update_requires_at_least_one_change", () => {
    const { root, home } = store();
    const path = note(root, "personal", "fermentor.md", FULL);
    expect(() =>
      updateNote({ root, cwd: "/anywhere", home }, {
        slug: "fermentor",
        scope: "personal",
        ifMatch: revisionOnDisk(path),
      })
    ).toThrow(NoChangesError);
  });

  test("update_rejects_a_stale_revision_without_touching_the_bytes", () => {
    const { root, home } = store();
    const path = note(root, "personal", "fermentor.md", FULL);
    const original = readFileSync(path);

    expect(() =>
      updateNote({ root, cwd: "/anywhere", home }, {
        slug: "fermentor",
        scope: "personal",
        ifMatch: "0".repeat(64),
        content: "no debe escribirse",
      })
    ).toThrow(RevisionMismatchError);

    expect(readFileSync(path)).toEqual(original);
    expect(leftovers(join(root, "personal"))).toEqual([]);
  });

  test("update_refuses_a_slug_that_does_not_exist", () => {
    const { root, home } = store();
    note(root, "personal", "fermentor.md", FULL);
    expect(() =>
      updateNote({ root, cwd: "/anywhere", home }, {
        slug: "inexistente",
        scope: "personal",
        ifMatch: "0".repeat(64),
        content: "x",
      })
    ).toThrow(NoteNotFoundError);
  });

  test("update_refuses_a_feedback_fact_because_facts_are_append_only", () => {
    const { root, home } = store();
    const dir = join(root, "personal", "facts");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "01J0000000000000000000000A.md");
    writeFileSync(path, [
      "---", "name: riego", "description: riego a las 7", "scope: personal",
      "created: 2026-06-01T10:00:00", "importance: 5", "type: feedback", "---", "observado", "",
    ].join("\n"));
    const original = readFileSync(path);

    expect(() =>
      updateNote({ root, cwd: "/anywhere", home }, {
        slug: "riego",
        scope: "personal",
        ifMatch: revisionOnDisk(path),
        content: "reescrito",
      })
    ).toThrow(NotEditableError);
    expect(readFileSync(path)).toEqual(original);
  });

  test("update_refuses_two_files_claiming_the_same_slug", () => {
    const { root, home } = store();
    const a = note(root, "personal", "fermentor.md", FULL);
    // A hand-copied note that kept the original `name`: the index would reject
    // this pair too, but update must not depend on the index being current.
    note(root, "personal", "copia.md", FULL);
    const original = readFileSync(a);

    expect(() =>
      updateNote({ root, cwd: "/anywhere", home }, {
        slug: "fermentor",
        scope: "personal",
        ifMatch: revisionOnDisk(a),
        content: "x",
      })
    ).toThrow(DuplicateSlugError);
    expect(readFileSync(a)).toEqual(original);
  });

  test("update_refuses_a_note_whose_filename_disagrees_with_its_name", () => {
    const { root, home } = store();
    const path = note(root, "personal", "otro-nombre.md", FULL);
    expect(() =>
      updateNote({ root, cwd: "/anywhere", home }, {
        slug: "fermentor",
        scope: "personal",
        ifMatch: revisionOnDisk(path),
        content: "x",
      })
    ).toThrow(IdentityMismatchError);
  });

  test("update_refuses_a_note_whose_frontmatter_scope_disagrees_with_its_folder", () => {
    const { root, home } = store(["personal", "work"]);
    const path = note(root, "personal", "fermentor.md", [
      ...FULL.filter((l) => !l.startsWith("scope:")),
      "scope: work",
    ]);
    expect(() =>
      updateNote({ root, cwd: "/anywhere", home }, {
        slug: "fermentor",
        scope: "personal",
        ifMatch: revisionOnDisk(path),
        content: "x",
      })
    ).toThrow(IdentityMismatchError);
  });

  test("update_refuses_a_note_whose_frontmatter_does_not_satisfy_the_schema", () => {
    const { root, home } = store();
    const path = note(root, "personal", "fermentor.md", [
      "name: fermentor", "description: d", "scope: personal",
      "created: 2026-06-01T10:00:00", "importance: 99", "type: reference",
    ]);
    const original = readFileSync(path);
    expect(() =>
      updateNote({ root, cwd: "/anywhere", home }, {
        slug: "fermentor",
        scope: "personal",
        ifMatch: revisionOnDisk(path),
        content: "x",
      })
    ).toThrow(IdentityMismatchError);
    expect(readFileSync(path)).toEqual(original);
  });

  test("update_refuses_a_symlinked_target", () => {
    const { root, home } = store();
    const real = join(root, "fuera.md");
    writeFileSync(real, `---\n${FULL.join("\n")}\n---\ncuerpo\n`);
    const link = join(root, "personal", "fermentor.md");
    symlinkSync(real, link);
    const original = readFileSync(real);

    expect(() =>
      updateNote({ root, cwd: "/anywhere", home }, {
        slug: "fermentor",
        scope: "personal",
        ifMatch: revisionOnDisk(link),
        content: "x",
      })
    ).toThrow(NotRegularFileError);
    // Neither the link nor its target moved.
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real)).toEqual(original);
  });

  test("update_with_an_invalid_importance_is_refused_before_anything_is_written", () => {
    const { root, home } = store();
    const path = note(root, "personal", "fermentor.md", FULL);
    const original = readFileSync(path);

    expect(() =>
      updateNote({ root, cwd: "/anywhere", home }, {
        slug: "fermentor",
        scope: "personal",
        ifMatch: revisionOnDisk(path),
        importance: 42,
      })
    ).toThrow();

    // The RESULT is validated too, not just the document already on disk — and
    // it is validated before the temporary exists, so nothing was written.
    expect(readFileSync(path)).toEqual(original);
    expect(leftovers(join(root, "personal"))).toEqual([]);
  });

  test("update_cleans_up_the_temporary_when_the_rename_fails", () => {
    const { root, home } = store();
    const path = note(root, "personal", "fermentor.md", FULL);
    const original = readFileSync(path);

    fsHook.failRename = true;
    fsHook.lastRenamedFrom = "";
    try {
      expect(() =>
        updateNote({ root, cwd: "/anywhere", home }, {
          slug: "fermentor",
          scope: "personal",
          ifMatch: revisionOnDisk(path),
          content: "esto no debe llegar al disco",
        })
      ).toThrow(/cross-device/);
    } finally {
      fsHook.failRename = false;
    }

    // The temporary really was created — otherwise this test would pass for the
    // wrong reason, which is exactly what the cheaper negative cases do.
    expect(fsHook.lastRenamedFrom).toContain(".tmp-");
    expect(existsSync(fsHook.lastRenamedFrom)).toBe(false); // ...and then removed
    expect(readFileSync(path)).toEqual(original);
    expect(leftovers(join(root, "personal"))).toEqual([]);
    // A failed swap still releases the scope.
    expect(existsSync(join(root, "personal", ".mneme-write.lock"))).toBe(false);
  });

  test("update_reports_a_note_deleted_between_the_walk_and_the_lock_as_not_found", () => {
    const { root, home } = store();
    const path = note(root, "personal", "fermentor.md", FULL);
    const ifMatch = revisionOnDisk(path);
    // The walk located it; by the time the lock is held it is gone. The user
    // must get a domain error, never Node's raw ENOENT.
    fsHook.vanishOnStat = path;
    try {
      expect(() =>
        updateNote({ root, cwd: "/anywhere", home }, {
          slug: "fermentor", scope: "personal", ifMatch, content: "x",
        })
      ).toThrow(NoteNotFoundError);
    } finally {
      fsHook.vanishOnStat = "";
    }
  });

  test("update_refuses_a_secret_pasted_into_the_new_description", () => {
    const { root, home } = store();
    const path = note(root, "personal", "fermentor.md", FULL);
    const original = readFileSync(path);

    expect(() =>
      updateNote({ root, cwd: "/anywhere", home }, {
        slug: "fermentor",
        scope: "personal",
        ifMatch: revisionOnDisk(path),
        description: "token sk-abcdefghij0123456789",
      })
    ).toThrow(SecretDetectedError);

    expect(readFileSync(path)).toEqual(original);
    expect(leftovers(join(root, "personal"))).toEqual([]);
  });

  test("update_refuses_a_secret_in_the_new_body", () => {
    const { root, home } = store();
    const path = note(root, "personal", "fermentor.md", FULL);
    const original = readFileSync(path);

    expect(() =>
      updateNote({ root, cwd: "/anywhere", home }, {
        slug: "fermentor",
        scope: "personal",
        ifMatch: revisionOnDisk(path),
        content: "la clave es sk-abcdefghij0123456789",
      })
    ).toThrow(SecretDetectedError);
    expect(readFileSync(path)).toEqual(original);
  });

  test("update_refuses_a_scope_this_machine_does_not_own", () => {
    const { root, home } = store([]);
    const path = note(root, "personal", "fermentor.md", FULL);
    expect(() =>
      updateNote({ root, cwd: "/anywhere", home }, {
        slug: "fermentor",
        scope: "personal",
        ifMatch: revisionOnDisk(path),
        content: "x",
      })
    ).toThrow(NotOwnerError);
  });

  test("update_is_fail_closed_when_the_cwd_maps_to_no_scope", () => {
    const { root, home } = store();
    const path = note(root, "personal", "fermentor.md", FULL);
    expect(() =>
      updateNote({ root, cwd: "/anywhere", home }, {
        slug: "fermentor",
        ifMatch: revisionOnDisk(path),
        content: "x",
      })
    ).toThrow(ScopeUnresolvedError);
  });

  test("update_resolves_the_scope_from_the_cwd_when_none_is_given", () => {
    const wd = mkdtempSync(join(tmpdir(), "mneme-wd-"));
    const { root, home } = store(["personal"], `${wd} = personal\n`);
    const path = note(root, "personal", "fermentor.md", FULL);

    const res = updateNote({ root, cwd: wd, home }, {
      slug: "fermentor",
      ifMatch: revisionOnDisk(path),
      content: "desde el cwd\n",
    });

    expect(res.scope).toBe("personal");
    expect(readFileSync(path, "utf8")).toContain("desde el cwd");
  });

  test("update_fsyncs_the_temporary_before_the_rename_and_the_directory_after_it", () => {
    const { root, home } = store();
    const path = note(root, "personal", "fermentor.md", FULL);
    fsHook.durability = [];

    updateNote({ root, cwd: "/anywhere", home }, {
      slug: "fermentor",
      scope: "personal",
      ifMatch: revisionOnDisk(path),
      content: "cuerpo que debe sobrevivir a un corte de luz\n",
    });

    const tmp = fsHook.lastRenamedFrom;
    expect(tmp).toContain(".tmp-");
    // Only the order is worth pinning: the bytes have to be on disk before the
    // directory entry that publishes them, and the entry itself after that.
    expect(fsHook.durability).toEqual([
      `fsync:${tmp}`,
      `rename:${tmp}`,
      `fsync:${join(root, "personal")}`,
    ]);
  });

  test("update_preserves_the_original_file_mode", () => {
    const { root, home } = store();
    const path = note(root, "personal", "fermentor.md", FULL);
    chmodSync(path, 0o640);
    const before = statSync(path).mode;

    updateNote({ root, cwd: "/anywhere", home }, {
      slug: "fermentor",
      scope: "personal",
      ifMatch: revisionOnDisk(path),
      content: "nuevo\n",
    });

    expect(statSync(path).mode).toBe(before);
  });
});

describe("line endings", () => {
  /**
   * A note written on Windows, or synced from a machine that was. `update`
   * reserializes the whole document even when only the frontmatter changes, and
   * `parseFrontmatter` normalizes CRLF to LF on the way in — so a one-word
   * change to the description used to rewrite every line of a body nobody
   * touched. In a synced, hand-editable store that is a diff the user did not
   * ask for.
   */
  test("update_keeps_crlf_line_endings_when_only_the_description_changes", () => {
    const { root, home } = store();
    const crlf = (s: string): string => s.replace(/\n/g, "\r\n");
    const path = join(root, "personal", "fermentor.md");
    mkdirSync(join(root, "personal"), { recursive: true });
    writeFileSync(path, crlf(`---\n${FULL.join("\n")}\n---\ncuerpo original\nsegunda linea\n`));

    updateNote({ root, cwd: "/anywhere", home }, {
      slug: "fermentor",
      scope: "personal",
      ifMatch: revisionOnDisk(path),
      description: "receta revisada",
    });

    const after = readFileSync(path, "utf8");
    expect(after).toContain("description: receta revisada");
    expect(after).toContain("cuerpo original\r\nsegunda linea\r\n");
    expect(after.includes("cuerpo original\nsegunda linea")).toBe(false);
  });

  test("update_of_a_crlf_note_returns_the_revision_of_the_bytes_on_disk", () => {
    // The returned revision is what the caller feeds to the NEXT --if-match.
    // Hashing the pre-conversion text would hand back a revision no file ever
    // had, and the following update would be refused as a phantom conflict.
    const { root, home } = store();
    const path = join(root, "personal", "fermentor.md");
    mkdirSync(join(root, "personal"), { recursive: true });
    writeFileSync(path, `---\r\n${FULL.join("\r\n")}\r\n---\r\ncuerpo original\r\n`);

    const res = updateNote({ root, cwd: "/anywhere", home }, {
      slug: "fermentor",
      scope: "personal",
      ifMatch: revisionOnDisk(path),
      description: "receta revisada",
    });

    expect(res.revision).toBe(revisionOnDisk(path));
  });

  test("update_leaves_an_lf_note_on_lf", () => {
    // The mirror of the above: preserving what was there must not mean
    // introducing CRLF into a file that never had it.
    const { root, home } = store();
    const path = note(root, "personal", "fermentor.md", FULL, "cuerpo original\nsegunda linea\n");

    updateNote({ root, cwd: "/anywhere", home }, {
      slug: "fermentor",
      scope: "personal",
      ifMatch: revisionOnDisk(path),
      description: "receta revisada",
    });

    expect(readFileSync(path, "utf8")).not.toContain("\r\n");
  });
});

describe("supersession", () => {
  /**
   * The point of these fields is to give an agent a move OTHER than writing a
   * third nearly-identical note when it learns something changed. So the write
   * path has to make the relation cheap, and the incoherent states impossible.
   */
  test("update_marks_a_note_superseded_and_names_the_replacement", () => {
    const { root, home } = store();
    const path = note(root, "personal", "db-migration.md", FULL.map((l) => l.replace("name: fermentor", "name: db-migration")));
    note(root, "personal", "db-migration-v2.md", FULL.map((l) => l.replace("name: fermentor", "name: db-migration-v2")));

    updateNote({ root, cwd: "/anywhere", home }, {
      slug: "db-migration",
      scope: "personal",
      ifMatch: revisionOnDisk(path),
      supersededBy: "db-migration-v2",
    });

    const doc = parseFrontmatter(readFileSync(path, "utf8"));
    expect(doc.data.status).toBe("superseded");
    expect(doc.data.superseded_by).toBe("db-migration-v2");
    // Nothing is destroyed: the body is exactly what it was.
    expect(doc.body).toContain("cuerpo original");
  });

  test("update_refuses_a_pointer_to_a_note_that_does_not_exist", () => {
    // A dangling pointer is worse than no pointer: the note drops out of the
    // ranking and names a replacement nobody can read.
    const { root, home } = store();
    const path = note(root, "personal", "fermentor.md", FULL);
    const before = readFileSync(path, "utf8");

    expect(() => updateNote({ root, cwd: "/anywhere", home }, {
      slug: "fermentor",
      scope: "personal",
      ifMatch: revisionOnDisk(path),
      supersededBy: "no-existe",
    })).toThrow(UnknownSupersederError);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("update_refuses_a_note_that_supersedes_itself", () => {
    const { root, home } = store();
    const path = note(root, "personal", "fermentor.md", FULL);
    const before = readFileSync(path, "utf8");

    expect(() => updateNote({ root, cwd: "/anywhere", home }, {
      slug: "fermentor",
      scope: "personal",
      ifMatch: revisionOnDisk(path),
      supersededBy: "fermentor",
    })).toThrow();
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("update_flags_a_note_without_naming_any_replacement", () => {
    // `flagged` is the "somebody noticed a contradiction and has not resolved
    // it" state. It takes no pointer, and it is NOT hidden from the ranking.
    const { root, home } = store();
    const path = note(root, "personal", "fermentor.md", FULL);

    updateNote({ root, cwd: "/anywhere", home }, {
      slug: "fermentor", scope: "personal", ifMatch: revisionOnDisk(path), status: "flagged",
    });

    const doc = parseFrontmatter(readFileSync(path, "utf8"));
    expect(doc.data.status).toBe("flagged");
    expect(doc.data.superseded_by).toBeUndefined();
  });

  test("update_back_to_active_drops_both_fields", () => {
    // Absent means active, so going back writes neither key: a note that was
    // never superseded and one that stopped being superseded look the same on
    // disk, which is the only way the "absent means active" rule stays true.
    const { root, home } = store();
    const path = note(root, "personal", "fermentor.md", [...FULL, "status: flagged"]);

    updateNote({ root, cwd: "/anywhere", home }, {
      slug: "fermentor", scope: "personal", ifMatch: revisionOnDisk(path), status: "active",
    });

    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("status:");
    expect(raw).not.toContain("superseded_by:");
  });
});
