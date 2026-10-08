" ===== Global class (main include) =====
CLASS zbp_gtsitevisit DEFINITION PUBLIC ABSTRACT FINAL FOR BEHAVIOR OF zi_gtsitevisit.
ENDCLASS.
CLASS zbp_gtsitevisit IMPLEMENTATION.
ENDCLASS.

" ===== Local types: behavior handler (CCIMP, includes/implementations) =====
CLASS lhc_sitevisit DEFINITION INHERITING FROM cl_abap_behavior_handler.
  PRIVATE SECTION.
    METHODS get_global_authorizations FOR GLOBAL AUTHORIZATION
      IMPORTING REQUEST requested_authorizations FOR sitevisit RESULT result.
    METHODS get_instance_features FOR INSTANCE FEATURES
      IMPORTING keys REQUEST requested_features FOR sitevisit RESULT result.
    METHODS setdefaults FOR DETERMINE ON MODIFY
      IMPORTING keys FOR sitevisit~setdefaults.
    METHODS close FOR MODIFY
      IMPORTING keys FOR ACTION sitevisit~close RESULT result.
ENDCLASS.

CLASS lhc_sitevisit IMPLEMENTATION.
  METHOD get_global_authorizations.
  ENDMETHOD.

  METHOD get_instance_features.
    READ ENTITIES OF zi_gtsitevisit IN LOCAL MODE
      ENTITY sitevisit FIELDS ( status ) WITH CORRESPONDING #( keys )
      RESULT DATA(visits).
    result = VALUE #( FOR v IN visits
                      ( %tky = v-%tky
                        %action-close = COND #( WHEN v-status = 'C'
                                                THEN if_abap_behv=>fc-o-disabled
                                                ELSE if_abap_behv=>fc-o-enabled ) ) ).
  ENDMETHOD.

  METHOD setdefaults.
    MODIFY ENTITIES OF zi_gtsitevisit IN LOCAL MODE
      ENTITY sitevisit UPDATE FIELDS ( status durationunit )
      WITH VALUE #( FOR k IN keys ( %tky = k-%tky status = 'O' durationunit = 'MIN' ) ).
  ENDMETHOD.

  METHOD close.
    READ ENTITIES OF zi_gtsitevisit IN LOCAL MODE
      ENTITY sitevisit FIELDS ( status arrivedat ) WITH CORRESPONDING #( keys )
      RESULT DATA(visits).
    LOOP AT keys INTO DATA(key).
      READ TABLE visits WITH KEY id COMPONENTS %tky = key-%tky INTO DATA(visit).
      IF sy-subrc <> 0.
        APPEND VALUE #( %tky = key-%tky %fail-cause = if_abap_behv=>cause-not_found ) TO failed-sitevisit.
        CONTINUE.
      ENDIF.
      IF visit-status = 'C'.
        APPEND VALUE #( %tky = key-%tky ) TO failed-sitevisit.
        APPEND VALUE #( %tky = key-%tky
                        %msg = new_message_with_text( severity = if_abap_behv_message=>severity-error
                                                      text     = 'Visit already closed' ) ) TO reported-sitevisit.
        CONTINUE.
      ENDIF.
      DATA(departed) = key-%param-departedat.
      DATA(seconds)  = cl_abap_tstmp=>subtract( tstmp1 = departed tstmp2 = visit-arrivedat ).
      MODIFY ENTITIES OF zi_gtsitevisit IN LOCAL MODE
        ENTITY sitevisit UPDATE FIELDS ( status departedat duration )
        WITH VALUE #( ( %tky = key-%tky status = 'C' departedat = departed duration = seconds / 60 ) ).
    ENDLOOP.
    READ ENTITIES OF zi_gtsitevisit IN LOCAL MODE
      ENTITY sitevisit ALL FIELDS WITH CORRESPONDING #( keys )
      RESULT DATA(updated).
    result = VALUE #( FOR u IN updated ( %tky = u-%tky %param = u ) ).
  ENDMETHOD.
ENDCLASS.

" ===== Test classes (CCAU, includes/testclasses) =====
CLASS ltc_close DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.
  PRIVATE SECTION.
    CONSTANTS visit_id TYPE sysuuid_x16 VALUE '11111111111111111111111111111111'.
    CONSTANTS arrived  TYPE timestampl  VALUE '20260923100000.0000000'.
    CONSTANTS departed TYPE timestampl  VALUE '20260923101000.0000000'. " arrived + 600 s
    CLASS-DATA cds TYPE REF TO if_cds_test_environment.
    CLASS-METHODS class_setup.
    CLASS-METHODS class_teardown.
    METHODS setup.
    METHODS create_visit.
    METHODS close_failed RETURNING VALUE(result) TYPE abap_bool.
    METHODS close_sets_status_duration FOR TESTING RAISING cx_static_check.
    METHODS second_close_fails FOR TESTING RAISING cx_static_check.
    METHODS close_unknown_fails FOR TESTING RAISING cx_static_check.
ENDCLASS.

CLASS ltc_close IMPLEMENTATION.
  METHOD class_setup.
    " CDS doubles, not OSQL doubles: the managed READ goes through ZI_GTSiteVisit,
    " so its dependency ZGT_SITEVISIT must be doubled with Open SQL redirected to it
    cds = cl_cds_test_environment=>create( i_for_entity = 'ZI_GTSITEVISIT' ).
    cds->enable_double_redirection( ).
  ENDMETHOD.

  METHOD class_teardown.
    cds->destroy( ).
  ENDMETHOD.

  METHOD setup.
    cds->clear_doubles( ).
    ROLLBACK ENTITIES.
  ENDMETHOD.

  METHOD create_visit.
    MODIFY ENTITIES OF zi_gtsitevisit
      ENTITY sitevisit
        CREATE FIELDS ( visituuid zoneextid zonename device arrivedat exteventkey )
        WITH VALUE #( ( %cid = 'v1' visituuid = visit_id zoneextid = 'zone-1' zonename = 'Site A'
                        device = 'iphone' arrivedat = arrived exteventkey = 'iphone|zone-1|20260923100000' ) )
      FAILED DATA(failed).
    cl_abap_unit_assert=>assert_initial( act = failed msg = 'create failed' ).
    COMMIT ENTITIES RESPONSE OF zi_gtsitevisit FAILED DATA(commit_failed).
    cl_abap_unit_assert=>assert_initial( act = commit_failed msg = 'create commit failed' ).
    SELECT SINGLE status, visit_uuid FROM zgt_sitevisit INTO @DATA(created).
    cl_abap_unit_assert=>assert_equals( act = created-visit_uuid exp = visit_id msg = 'create not persisted' ).
    cl_abap_unit_assert=>assert_equals( act = created-status exp = 'O' msg = 'setDefaults did not run' ).
  ENDMETHOD.

  METHOD close_failed.
    MODIFY ENTITIES OF zi_gtsitevisit
      ENTITY sitevisit
        EXECUTE close FROM VALUE #( ( visituuid = visit_id %param-departedat = departed ) )
      FAILED DATA(failed).
    COMMIT ENTITIES.
    result = xsdbool( failed IS NOT INITIAL ).
  ENDMETHOD.

  METHOD close_sets_status_duration.
    create_visit( ).
    cl_abap_unit_assert=>assert_false( act = close_failed( ) msg = 'close failed' ).
    SELECT SINGLE status, duration_qty, duration_unit, departed_at FROM zgt_sitevisit
      WHERE visit_uuid = @visit_id INTO @DATA(row).
    cl_abap_unit_assert=>assert_equals( act = row-status exp = 'C' ).
    cl_abap_unit_assert=>assert_equals( act = row-duration_qty exp = 10 ).
    cl_abap_unit_assert=>assert_equals( act = row-duration_unit exp = 'MIN' ).
    cl_abap_unit_assert=>assert_equals( act = row-departed_at exp = departed ).
  ENDMETHOD.

  METHOD second_close_fails.
    create_visit( ).
    close_failed( ).
    cl_abap_unit_assert=>assert_true( act = close_failed( ) msg = 'second close must fail' ).
  ENDMETHOD.

  METHOD close_unknown_fails.
    " no create: the key does not exist
    cl_abap_unit_assert=>assert_true( act = close_failed( ) msg = 'close of unknown visit must fail, not dump' ).
  ENDMETHOD.
ENDCLASS.
