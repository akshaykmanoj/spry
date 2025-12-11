---
docFM:
  key1: "SQL PARTIAL fixture"
---

# SQL PARTIAL Injection Tests

This fixture tests SQL PARTIALs with various injection patterns.

```sql PARTIAL global-layout.sql --inject **/!(*api|*sqlpage)/**
-- BEGIN: PARTIAL global-layout.sql
SELECT 'shell' AS component,
       'Spry' AS title;

SET resource_json = sqlpage.read_file_as_text('spry.d/auto/resource/${path}.auto.json');
SET page_title  = json_extract($resource_json, '$.route.caption');
-- END: PARTIAL global-layout.sql
-- this is the `${cell.info}` cell on line ${cell.startLine}
```

```sql PARTIAL api-head.sql --inject ./api/**
-- BEGIN: PARTIAL api-head.sql
select
   'http_header' as component,
   'application/json' as "Content-Type";
-- END: PARTIAL api-head.sql
```

```sql PARTIAL handlebars.sql --inject ./sqlpage/**
{{!-- BEGIN: PARTIAL handlebars.sql 
-- END: PARTIAL handlebars.sql--}}
```

```sql index.sql { route: { caption: "Welcome" } }
-- @route.description "Welcome to UI."

```

## api

```sql api/ambulatory-glucose-profile/index.sql

```

```sql ../sqlpage/templates/gri_component.handlebars
<gri-chart></gri-chart>
```

