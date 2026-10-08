@AccessControl.authorizationCheck: #CHECK
@EndUserText.label: 'Site Visit'
define root view entity ZI_GTSiteVisit
  as select from zgt_sitevisit
{
  key visit_uuid            as VisitUUID,
      zone_ext_id           as ZoneExtID,
      zone_name             as ZoneName,
      device                as Device,
      arrived_at            as ArrivedAt,
      departed_at           as DepartedAt,
      @Semantics.quantity.unitOfMeasure: 'DurationUnit'
      duration_qty          as Duration,
      duration_unit         as DurationUnit,
      status                as Status,
      ext_event_key         as ExtEventKey,
      @Semantics.systemDateTime.createdAt: true
      created_at            as CreatedAt,
      @Semantics.systemDateTime.lastChangedAt: true
      last_changed_at       as LastChangedAt,
      @Semantics.systemDateTime.localInstanceLastChangedAt: true
      local_last_changed_at as LocalLastChangedAt
}
