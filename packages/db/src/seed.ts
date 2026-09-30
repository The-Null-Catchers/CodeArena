import { pool, tx } from "./index.js";
import { runtimes } from "../../shared/src/runtimes.js";
import argon2 from "argon2";
const samples = [
  [
    "two-sum",
    "Two Sum",
    "easy",
    "Read n and a target, then n integers. Print the zero-based indices of the first pair in lexicographic order that adds to the target. Print -1 if none exists.",
    "4 9\n2 7 11 15\n",
    "0 1\n",
    "3 8\n1 2 3\n",
    "-1\n",
  ],
  [
    "reverse-string",
    "Reverse String",
    "easy",
    "Read one line and print its characters in reverse order.",
    "arena\n",
    "anera\n",
    "sandbox\n",
    "xobdnas\n",
  ],
  [
    "valid-parentheses",
    "Balanced Brackets",
    "easy",
    "Read a string containing only ()[]{}. Print YES if balanced, otherwise NO.",
    "([])\n",
    "YES\n",
    "([)]\n",
    "NO\n",
  ],
  [
    "binary-search",
    "Locate a Number",
    "easy",
    "Read n, target and a sorted list of n unique integers. Print the zero-based target index or -1.",
    "5 7\n1 3 5 7 9\n",
    "3\n",
    "3 4\n1 2 3\n",
    "-1\n",
  ],
  [
    "fibonacci",
    "Fibonacci Number",
    "easy",
    "Read n (0 to 40). Print F(n), where F(0)=0 and F(1)=1.",
    "10\n",
    "55\n",
    "0\n",
    "0\n",
  ],
  [
    "merge-intervals",
    "Merge Ranges",
    "medium",
    "Read n then n closed integer intervals. Merge overlapping intervals and print each merged pair in ascending order. Touching endpoints overlap.",
    "3\n1 3\n2 6\n8 10\n",
    "1 6\n8 10\n",
    "2\n1 2\n2 3\n",
    "1 3\n",
  ],
  [
    "shortest-path",
    "Shortest Route",
    "hard",
    "Read n m then m undirected edges u v w with nonnegative weights. Vertices are 0..n-1. Print shortest distance from 0 to n-1, or -1.",
    "3 3\n0 1 2\n1 2 3\n0 2 9\n",
    "5\n",
    "3 1\n0 1 1\n",
    "-1\n",
  ],
  [
    "lru-cache",
    "Tiny LRU",
    "hard",
    "Read capacity and operation count, then PUT key value or GET key lines. Print value or -1 for each GET. Reads refresh recency; new inserts evict the least recently used entry.",
    "2 5\nPUT a 1\nPUT b 2\nGET a\nPUT c 3\nGET b\n",
    "1\n-1\n",
    "1 3\nPUT a 5\nPUT b 6\nGET a\n",
    "-1\n",
  ],
];
await tx(async (c) => {
  for (const r of runtimes)
    await c.query(
      "INSERT INTO runtimes(id,language,version,image) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [r.id, r.language, r.version, r.image],
    );
  for (const [
    slug,
    title,
    difficulty,
    description,
    input,
    expected,
    hiddenInput,
    hiddenExpected,
  ] of samples) {
    const row = await c.query(
      "INSERT INTO challenges(slug,title,difficulty,description) VALUES($1,$2,$3,$4) ON CONFLICT(slug) DO UPDATE SET title=excluded.title RETURNING id",
      [slug, title, difficulty, description],
    );
    for (const [position, stdin, out, hidden] of [
      [0, input, expected, false],
      [1, hiddenInput, hiddenExpected, true],
    ])
      await c.query(
        "INSERT INTO challenge_test_cases(challenge_id,position,stdin,expected,hidden) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [row.rows[0].id, position, stdin, out, hidden],
      );
  }
  if (process.env.DEMO_PASSWORD) {
    const hash = await argon2.hash(process.env.DEMO_PASSWORD, {
      type: argon2.argon2id,
    });
    const u = await c.query(
      "INSERT INTO users(email,password_hash) VALUES($1,$2) ON CONFLICT(email) DO NOTHING RETURNING id",
      ["demo@codearena.local", hash],
    );
    if (u.rowCount) {
      const org = await c.query(
        "INSERT INTO organizations(name) VALUES('Demo Organization') RETURNING id",
      );
      await c.query("INSERT INTO memberships VALUES($1,$2,'owner')", [
        org.rows[0].id,
        u.rows[0].id,
      ]);
      await c.query(
        "INSERT INTO projects(organization_id,name) VALUES($1,'Demo Project')",
        [org.rows[0].id],
      );
    }
  }
});
await pool.end();
