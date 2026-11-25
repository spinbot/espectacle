# Builds index.html (for GitHub Pages) from site.html, the page content shared with the preview.
import pathlib
here = pathlib.Path(__file__).parent
body = (here / 'site.html').read_text()
head_end = body.index('</style>') + len('</style>')
page = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
        + body[:head_end] + '\n</head>\n<body>\n' + body[head_end:].lstrip() + '</body>\n</html>\n')
(here / 'index.html').write_text(page)
print('wrote index.html', len(page))
