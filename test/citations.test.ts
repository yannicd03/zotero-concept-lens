import { assert } from "chai";
import { config } from "../package.json";

const api = () => (Zotero as any)[config.addonInstance].api.citations;

const PETS =
  "Kurtland Chua, Roberto Calandra, Rowan McAllister, and Sergey Levine. Deep Reinforcement Learning in a Handful of Trials using Probabilistic Dynamics Models. Adv. in Neural Information Processing Systems, 2018.";

const ENTRIES = [
  {
    id: 3,
    title:
      "Deep Reinforcement Learning in a Handful of Trials using Probabilistic Dynamics Models",
    year: 2018,
    doi: "10.48550/arxiv.1805.12114",
    arxiv: "1805.12114",
    creators: ["Chua", "Calandra", "McAllister", "Levine"],
  },
  {
    id: 19,
    title:
      "Dyna, an integrated architecture for learning, planning, and reacting",
    year: 1991,
    doi: "10.1145/122344.122377",
    creators: ["Sutton"],
  },
  {
    id: 11,
    title: "Portfolio Selection",
    year: 1952,
    creators: ["Markowitz"],
  },
  {
    id: 7,
    title: "Learning to trade via direct reinforcement",
    year: 2001,
    doi: "10.1109/72.935097",
    creators: ["Moody", "Saffell"],
  },
];

/** Structured chars for one line of text (one char per word, simplified). */
function line(text: string, x: number, y: number, last: "line" | "para") {
  const words = text.split(" ");
  return words.map((w, i) => ({
    c: w,
    rect: [x + i * 30, y, x + i * 30 + 25, y + 9] as [
      number,
      number,
      number,
      number,
    ],
    spaceAfter: i < words.length - 1,
    lineBreakAfter: i === words.length - 1 && last === "line",
    paragraphBreakAfter: i === words.length - 1 && last === "para",
  }));
}

/** Hanging-indent bibliography: entries at x=108, continuations at x=118. */
function bibChars() {
  return [
    ...line(
      "Kavosh Asadi. Lipschitz Continuity. arXiv, 2018.",
      108,
      300,
      "para",
    ),
    ...line(
      "Kurtland Chua, Roberto Calandra, Rowan McAllister,",
      108,
      280,
      "line",
    ),
    ...line("and Sergey Levine. Deep Reinforcement Learning", 118, 269, "line"),
    ...line("in a Handful of Trials. NeurIPS, 2018.", 118, 258, "line"),
    ...line("C. E. Shannon. A mathematical theory. 1948.", 108, 239, "line"),
    ...line("Dan Simon. Optimal State Estimation. 2006.", 108, 228, "para"),
  ];
}

describe("citations", function () {
  describe("identifiers", function () {
    it("extracts and normalises DOIs", function () {
      assert.equal(
        api().extractDOI("J. Moody. Learning to trade. doi:10.1109/72.935097."),
        "10.1109/72.935097",
      );
      assert.equal(
        api().extractDOI("https://doi.org/10.1145/122344.122377)"),
        "10.1145/122344.122377",
      );
      assert.isUndefined(api().extractDOI("No identifier here, 2018."));
    });

    it("extracts arXiv IDs in their common spellings", function () {
      const id = (s: string) => api().extractArxivId(s);
      assert.equal(id("arXiv preprint arXiv:1805.12114, 2018."), "1805.12114");
      assert.equal(id("arXiv:1805.12114v3 [cs.LG]"), "1805.12114");
      assert.equal(id("https://arxiv.org/abs/2501.16918"), "2501.16918");
      assert.equal(id("10.48550/arXiv.1805.12114"), "1805.12114");
      assert.equal(id("arXiv:cs/0101001"), "cs/0101001");
      assert.isUndefined(id("Model-based RL. arXiv, 2023."));
    });

    it("finds years but not page numbers or ISBN parts", function () {
      assert.deepEqual(
        api().extractYears(
          "Dan Simon. Optimal State Estimation. 2006. pp. 1995-2010.",
        ),
        [2006],
      );
    });
  });

  describe("title candidates", function () {
    it("keeps author initials together and yields the title segment", function () {
      const c: string[] = api().titleCandidates(
        "K. Chua, R. Calandra, R. McAllister, and S. Levine. Deep reinforcement learning in a handful of trials. In Proc. NeurIPS, 2018.",
      );
      assert.include(c, "Deep reinforcement learning in a handful of trials");
      assert.notInclude(c, "Chua, R");
    });

    it("takes quoted titles (IEEE style)", function () {
      const c: string[] = api().titleCandidates(
        '[12] R. S. Sutton, "Dyna, an integrated architecture for learning, planning, and reacting," SIGART Bull., vol. 2, 1991.',
      );
      assert.equal(
        c[0],
        "Dyna, an integrated architecture for learning, planning, and reacting",
      );
    });

    it("strips the year of APA-style references", function () {
      const c: string[] = api().titleCandidates(
        "Markowitz, H. (1952). Portfolio selection. The Journal of Finance, 7(1), 77-91.",
      );
      assert.include(c, "Portfolio selection");
    });
  });

  describe("matching", function () {
    it("matches the PETS reference to its library item by title", function () {
      const m = api().matchReference(PETS, ENTRIES);
      assert.deepEqual(m, { id: 3, by: "title", score: 1 });
    });

    it("prefers exact identifiers", function () {
      assert.equal(
        api().matchReference(
          "Some garbled text. doi: 10.1109/72.935097",
          ENTRIES,
        )?.by,
        "doi",
      );
      assert.deepInclude(
        api().matchReference("Chua et al. arXiv:1805.12114v4, 2018", ENTRIES),
        { id: 3, by: "arxiv" },
      );
    });

    it("tolerates a title mangled by text extraction", function () {
      const m = api().matchReference(
        "Richard S. Sutton. Dyna, an integrated architec- ture for learning, planing and reacting. SIGART Bull., 1991.",
        ENTRIES,
      );
      assert.equal(m?.id, 19);
      assert.isAtLeast(m.score, 0.85);
      assert.isBelow(m.score, 1);
    });

    it("rejects a similar title by other authors", function () {
      assert.isNull(
        api().matchReference(
          "Jane Doe. Deep Reinforcement Learning in a Handful of Trials using Probabilistic Dynamics Models. 2018.",
          ENTRIES,
        ),
      );
    });

    it("rejects a short title whose year disagrees", function () {
      // Same author and title words, different work.
      assert.isNull(
        api().matchReference(
          "Harry Markowitz. Portfolio selection. Wiley, 1959.",
          ENTRIES,
        ),
      );
      assert.equal(
        api().matchReference(
          "Harry Markowitz. Portfolio selection. Journal of Finance, 1952.",
          ENTRIES,
        )?.id,
        11,
      );
    });

    it("does not match references that are not in the library", function () {
      assert.isNull(
        api().matchReference(
          "Michael Janner, Justin Fu, Marvin Zhang, and Sergey Levine. When to trust your model: model-based policy optimization. In NeurIPS, 2019.",
          ENTRIES,
        ),
      );
    });

    it("reads arXiv IDs from item fields", function () {
      assert.equal(
        api().arxivIdFromFields("", "http://arxiv.org/abs/1805.12114", ""),
        "1805.12114",
      );
    });
  });

  describe("bibliography entry at a link destination", function () {
    it("cuts out the entry below the destination point", function () {
      assert.equal(
        api().entryAtPoint(bibChars(), 83, 292),
        "Kurtland Chua, Roberto Calandra, Rowan McAllister, and Sergey Levine. Deep Reinforcement Learning in a Handful of Trials. NeurIPS, 2018.",
      );
    });

    it("stops a one-line entry at the next entry on the margin", function () {
      assert.equal(
        api().entryAtPoint(bibChars(), null, 251),
        "C. E. Shannon. A mathematical theory. 1948.",
      );
    });

    it("finds nothing far from any line", function () {
      assert.isUndefined(api().entryAtPoint(bibChars(), 83, 600));
    });
  });

  describe("card text", function () {
    it("formats author lists", function () {
      const f = api().formatAuthors;
      assert.equal(f(["A"]), "A");
      assert.equal(f(["A", "B", "C"]), "A, B and C");
      assert.equal(f(["A", "B", "C", "D", "E"]), "A, B, C et al.");
    });

    it("truncates at a word boundary", function () {
      const t: string = api().truncate("word ".repeat(200), 600);
      assert.isAtMost(t.length, 601);
      assert.match(t, /word…$/);
    });
  });
});
