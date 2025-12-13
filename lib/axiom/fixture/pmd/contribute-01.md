Define some "contributions" which mean that we want these files as part of our
stream but the actual definition of what to do with them comes later.

```contribute my-contributions --base ../sundry
**/* SUNDRY
```

💡 The `--base` is relative to this markdown file.

```contribute my-contributions2 --labeled --base ../sundry --dest SUNDRY
CSV **/*.csv
PDF *.pdf
zip **/*.zip ARCHIVE
```
