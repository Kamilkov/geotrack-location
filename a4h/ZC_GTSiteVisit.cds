@EndUserText.label: 'Site Visit'
@AccessControl.authorizationCheck: #CHECK
@Metadata.allowExtensions: true
@UI.headerInfo: { typeName: 'Site Visit', typeNamePlural: 'Site Visits', title: { value: 'ZoneName' } }
define root view entity ZC_GTSiteVisit
  provider contract transactional_query
  as projection on ZI_GTSiteVisit
{
  @UI.facet: [{ id: 'Visit', type: #IDENTIFICATION_REFERENCE, label: 'Visit', position: 10 }]
  key VisitUUID,
  @UI: { lineItem: [{ position: 10 }], identification: [{ position: 10 }], selectionField: [{ position: 10 }] }
  ZoneName,
  @UI: { lineItem: [{ position: 20 }], identification: [{ position: 20 }] }
  Device,
  @UI: { lineItem: [{ position: 30 }], identification: [{ position: 30 }] }
  ArrivedAt,
  @UI: { lineItem: [{ position: 40 }], identification: [{ position: 40 }] }
  DepartedAt,
  @UI: { lineItem: [{ position: 50 }], identification: [{ position: 50 }] }
  Duration,
  DurationUnit,
  @UI: { lineItem: [{ position: 60 }], identification: [{ position: 60 }], selectionField: [{ position: 20 }] }
  Status,
  ZoneExtID,
  ExtEventKey,
  LocalLastChangedAt
}
