# Fonts

The four faces `publish` embeds in the page as base64 `woff2` ([page.md](../references/page.md#type)), 58KB together, under the page's 200KB font budget. Each is one static weight, subset to Latin plus the page's glyphs.

| File | Face | From |
| --- | --- | --- |
| `atkinson-hyperlegible-next-400.woff2` | Atkinson Hyperlegible Next, 400 | Atkinson Hyperlegible Next, Google Fonts v7 |
| `atkinson-hyperlegible-next-700.woff2` | Atkinson Hyperlegible Next, 700 | the same file |
| `ballot-serif-400.woff2` | Ballot Serif, 400 | Source Serif 4, Google Fonts v15 |
| `ballot-serif-600.woff2` | Ballot Serif, 600 | the same file |

Both families are under the SIL Open Font License 1.1: [OFL-atkinson-hyperlegible-next.txt](OFL-atkinson-hyperlegible-next.txt) and [OFL-source-serif.txt](OFL-source-serif.txt). Instancing and subsetting make a Modified Version, and Source Serif reserves the font name "Source", so its faces are renamed Ballot Serif in their name tables; their copyright and license records are kept as written.

## Rebuilding

The sources are Google Fonts' variable Latin files, which the `css2` API serves for every weight:

```text
https://fonts.gstatic.com/s/atkinsonhyperlegiblenext/v7/NaPNcYPdHfdVxJw0IfIP0lvYFqijb-UxCtm5_wdGseiJn3q0pkZ_.woff2
  sha256 1e4cea71d75ec427581d6259fc07148a2e60d60d16cabf4b4f5360487b3f9dc3, saved as atkinson.woff2
https://fonts.gstatic.com/s/sourceserif4/v15/vEFF2_tTDB4M7-auWDN0ahZJW3IX2ih5nk3AucvUHf6kDXr4Y3qwzQ.woff2
  sha256 8e38e3fbd74dea20aabe0831ffef04c9f30bf6fc5b99b7a2649be0dd8c6d859c, saved as sourceserif.woff2
```

Each face is pinned to its weight with fontTools 4.60.1, subset, and the serif faces renamed:

```bash
FT=(uvx --from 'fonttools[woff]==4.60.1')
UNICODES='U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2190-2193,U+2197,U+2212,U+25B8,U+25BE,U+25CB,U+2713,U+FFFD'
build() { # source weight out
  "${FT[@]}" fonttools varLib.instancer --static --update-name-table -q -o "$3.ttf" "$1" "wght=$2"
  "${FT[@]}" pyftsubset "$3.ttf" --unicodes="$UNICODES" \
    --layout-features='kern,liga,calt,ccmp,locl,mark,mkmk' --flavor=woff2 --output-file="$3.woff2"
  rm "$3.ttf"
}
build atkinson.woff2 400 atkinson-hyperlegible-next-400
build atkinson.woff2 700 atkinson-hyperlegible-next-700
build sourceserif.woff2 400 ballot-serif-400
build sourceserif.woff2 600 ballot-serif-600
```

The rename replaces `Source Serif 4` with `Ballot Serif` and `SourceSerif4` with `BallotSerif` in every name record of the two serif files except IDs 0, 13 and 14 (copyright, license, license URL), using fontTools' `TTFont`, and saves them in place.
