@EndUserText.label : 'GeoTrack site visit'
@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE
@AbapCatalog.tableCategory : #TRANSPARENT
@AbapCatalog.deliveryClass : #A
@AbapCatalog.dataMaintenance : #RESTRICTED
define table zgt_sitevisit {

  key client            : abap.clnt not null;
  key visit_uuid        : sysuuid_x16 not null;
  zone_ext_id           : abap.char(36);
  zone_name             : abap.char(60);
  device                : abap.char(40);
  arrived_at            : timestampl;
  departed_at           : timestampl;
  @Semantics.quantity.unitOfMeasure : 'zgt_sitevisit.duration_unit'
  duration_qty          : abap.quan(13,3);
  duration_unit         : abap.unit(3);
  status                : abap.char(1);
  ext_event_key         : abap.char(120);
  created_at            : abp_creation_tstmpl;
  last_changed_at       : abp_lastchange_tstmpl;
  local_last_changed_at : abp_locinst_lastchange_tstmpl;

}
