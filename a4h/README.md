# A4H: RAP `SiteVisit`

Documentation copies of the ABAP objects on A4H (ABAP Platform 2025, release 816), client 001.
The files here were exported from the **active** versions on the system. The system itself is the source of truth.

| Object | Type | File |
|---|---|---|
| `$ZGEOTRACK` | Package (local, software component LOCAL, no transport) | |
| `ZGT_SITEVISIT` | Table | `zgt_sitevisit.ddl` |
| `ZA_GTCLOSEVISIT` | Abstract entity (action parameter) | `ZA_GTCloseVisit.cds` |
| `ZI_GTSITEVISIT` | Root view entity + managed BDEF | `ZI_GTSiteVisit.cds`, `ZI_GTSiteVisit.bdef` |
| `ZBP_GTSITEVISIT` | Behavior pool (main, handler, ABAP Unit) | `ZBP_GTSiteVisit.abap` |
| `ZC_GTSITEVISIT` | Projection view + projection BDEF | `ZC_GTSiteVisit.cds`, `ZC_GTSiteVisit.bdef` |
| `ZSD_GTSITEVISIT` | Service definition | `ZSD_GTSiteVisit.srvd` |
| `ZSB_GTSITEVISIT_O4` | Service binding, OData V4, Web API (A2X), published | |

## Service

Service root (relative to the A4H host, `http://localhost:50000` through the SSH tunnel):

```
/sap/opu/odata4/sap/zsb_gtsitevisit_o4/srvd_a2x/sap/zsd_gtsitevisit/0001/
```

The `srvd` (UI) variant of the URL returns 403 because this is a Web API binding.

- Entity set `SiteVisit`, key `VisitUUID` (`Edm.Guid`)
- Properties: `ZoneExtID`, `ZoneName`, `Device`, `ArrivedAt` / `DepartedAt` (`Edm.DateTimeOffset`, precision 7),
  `Duration` (`Edm.Decimal` 13,3), `DurationUnit` (always `MIN`), `Status` (`O` open / `C` closed), `ExtEventKey`,
  `LocalLastChangedAt` (ETag)
- Create: the client must supply `VisitUUID` (no managed numbering). `ZoneExtID`, `ZoneName`, `Device`, `ArrivedAt`
  and `ExtEventKey` are mandatory. `Status`, `DepartedAt`, `Duration` and `DurationUnit` are read-only. Create sets `Status = 'O'` and `DurationUnit = 'MIN'`.
- Bound action `close`, parameter `DepartedAt`, returns the updated `SiteVisit`:

```
POST <root>SiteVisit(<uuid>)/SAP__self.close              {"DepartedAt":"2026-09-23T10:10:00Z"}
POST <root>SiteVisit(VisitUUID=<uuid>)/SAP__self.close    (equivalent)
```

  `SAP__self` is the schema alias for `com.sap.gateway.srvd_a2x.zsd_gtsitevisit.v0001`. The GUID is unquoted.
  The action sets `Status = 'C'`, `DepartedAt`, and `Duration` = (DepartedAt - ArrivedAt) in minutes.

Observed behaviour (live, 2026-09-23):

- Every POST/DELETE needs a CSRF token and its session cookie: first `GET <root>` with `x-csrf-token: fetch`.
- `close` without `If-Match` → 200.
- `close` on a visit that is already closed → 422 `RAP_RUNTIME/025` "Operation is not enabled" (instance feature control).
- `close` on an unknown key → 404.
- `DELETE SiteVisit(<uuid>)` with `If-Match: *` → 204.
