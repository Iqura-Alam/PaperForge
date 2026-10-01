# PaperForge Template Files

This directory contains class and style files for academic venues that are not
bundled in standard TeX Live distributions.

Files populated at Docker build time:
- `acl.sty` — ACL / EMNLP / NAACL style (from github.com/acl-org/acl-style-files)
- `acl_natbib.bst` — ACL BibTeX style
- `llncs.cls` — Springer LNCS class (from CTAN)

Files distributed by TeX Live packages (texlive-publishers):
- `IEEEtran.cls` — IEEE Conference / Transactions
- `acmart.cls` — ACM Conference / Journal

Templates that use standard LaTeX classes with geometry (no extra files needed):
- ICML — `article` with geometry/times packages
- ICLR — `article` with geometry/times/hyperref packages
