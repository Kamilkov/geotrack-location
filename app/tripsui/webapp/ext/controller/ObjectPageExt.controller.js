sap.ui.define([
  "sap/ui/core/mvc/ControllerExtension",
  "sap/ui/model/json/JSONModel",
  "sap/m/LightBox",
  "sap/m/LightBoxItem",
  "sap/viz/ui5/controls/VizTooltip",
  "sap/m/MessageBox",
  "sap/m/MessageToast",
  "sap/ui/Device"
], function (ControllerExtension, JSONModel, LightBox, LightBoxItem, VizTooltip, MessageBox, MessageToast, Device) {
  "use strict";

  // keep in sync with @cds.query.limit.max on TripMinutes in srv/trip-service.cds
  var MAX_MINUTES = 5000;

  // The map's height, in px: GeoMap redraws for a change of its own height property, not when its
  // container or the window is resized, so the height is set again on every window resize.
  var MAP_SIZES = ["small", "normal", "large"];
  var MAP_MIN = 420;        // small: the height it had before it followed the window; the floor of the others
  var MAP_SHARE = 0.6;      // normal: this share of the window height
  var MAP_CHROME = 136;     // large: the window less the snapped page title (68-76 px) and some room
  var MAP_SIZE_KEY = "geotrack.mapSize";

  var OSM_MAP_CONFIGURATION = {
    MapProvider: [{
      name: "OSM", type: "", description: "OpenStreetMap", tileX: "256", tileY: "256", maxLOD: "19",
      copyright: "© OpenStreetMap contributors",
      Source: [{ id: "s1", url: "https://tile.openstreetmap.org/{LOD}/{X}/{Y}.png" }]
    }],
    MapLayerStacks: [{ name: "DEFAULT", MapLayer: [{ name: "layer1", refMapProvider: "OSM", opacity: "1.0", colBkgnd: "RGB(255,255,255)" }] }]
  };

  function vizProperties(valueTitle, value2Title) {
    return {
      title: { visible: false },
      legend: { visible: true },
      plotArea: { dataLabel: { visible: false }, window: { start: "firstDataPoint", end: "lastDataPoint" } },
      timeAxis: { title: { visible: false } },
      valueAxis: { title: { visible: true, text: valueTitle } },
      valueAxis2: { title: { visible: !!value2Title, text: value2Title || "" } }
    };
  }

  /** Chart labels come from i18n through the model; the feeds use the measures' fixed identities. */
  function emptyState(texts) {
    return {
      labels: texts,
      loading: true, error: null,
      hasRoute: false, routes: [], spots: [], center: "0;0", zoom: 3, mapConfiguration: OSM_MAP_CONFIGURATION,
      hasWorkout: false, hasWatchRoute: false, hr: [], profile: [],
      hrViz: vizProperties("bpm"), profileViz: vizProperties("m", "km/h"),
      photos: [], deleting: false
    };
  }

  /** "LINESTRING(lon lat, lon lat, …)" → [[lon, lat], …]; null for empty or unparsable text. */
  function parseWkt(wkt) {
    var m = /^\s*LINESTRING\s*\(([^)]*)\)\s*$/i.exec(wkt || "");
    if (!m) { return null; }
    var points = m[1].split(",").map(function (pair) {
      var xy = pair.trim().split(/\s+/).map(Number);
      return xy.length >= 2 && isFinite(xy[0]) && isFinite(xy[1]) ? [xy[0], xy[1]] : null;
    });
    return points.length >= 2 && points.every(Boolean) ? points : null;
  }

  /** Whole-degree extent → VBM zoom level (~256px tiles): 360° ≈ zoom 0. */
  function zoomFor(extentDeg) {
    var z = Math.floor(Math.log2(360 / Math.max(extentDeg, 0.0005))) - 1;
    return Math.max(3, Math.min(17, z));
  }

  /** The map's height for a window `windowHeight` px tall: 420 px, 60% of the window, or nearly all of it. */
  function mapHeight(size, windowHeight) {
    var px = size === "large" ? windowHeight - MAP_CHROME : size === "normal" ? windowHeight * MAP_SHARE : MAP_MIN;
    return Math.max(MAP_MIN, Math.round(px)) + "px";
  }

  /** The size the map had last in this browser; normal when unknown or when storage is off (private mode). */
  function storedSize() {
    try {
      var size = window.localStorage.getItem(MAP_SIZE_KEY);
      return MAP_SIZES.indexOf(size) >= 0 ? size : "normal";
    } catch (e) { return "normal"; }
  }

  function storeSize(size) {
    try { window.localStorage.setItem(MAP_SIZE_KEY, size); } catch (e) { /* not remembered */ }
  }

  function hhmm(iso) {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  /** Route, start/end spots and one spot per photo; centre and zoom fit the route and the photos. */
  function mapState(wkt, photos, texts) {
    var route = parseWkt(wkt);
    if (!route) { return { hasRoute: false, routes: [], spots: [] }; }
    var all = route.concat(photos.map(function (p) { return [Number(p.lon), Number(p.lat)]; }));
    var bbox = all.reduce(function (b, p) {
      return [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])];
    }, [Infinity, Infinity, -Infinity, -Infinity]);
    var first = route[0], last = route[route.length - 1];
    var pos = function (p) { return p[0] + ";" + p[1] + ";0"; };
    return {
      hasRoute: true,
      routes: [{ position: route.map(pos).join(";") }],
      spots: [
        { position: pos(first), type: "Success", text: texts.start, tooltip: texts.start, photoID: null },
        { position: pos(last), type: "Error", text: texts.end, tooltip: texts.end, photoID: null }
      ].concat(photos.map(function (p) {
        var t = hhmm(p.takenAt) + (p.positionSource === "owntracks" ? " (" + texts.positionFromOwnTracks + ")" : "");
        return { position: pos([Number(p.lon), Number(p.lat)]), type: "Default", text: "", tooltip: t, photoID: p.ID };
      })),
      center: ((bbox[0] + bbox[2]) / 2) + ";" + ((bbox[1] + bbox[3]) / 2),
      zoom: zoomFor(Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]))
    };
  }

  /** Minute rows → heart-rate series and, when the Watch recorded a route, the altitude/speed series. */
  function chartState(minutes) {
    var num = function (v) { return v === null || v === undefined ? null : Number(v); };
    var hr = [], profile = [];
    minutes.forEach(function (m) {
      var t = new Date(m.minuteTS);
      if (m.hrAvg !== null && m.hrAvg !== undefined) { hr.push({ t: t, hrAvg: num(m.hrAvg), hrMax: num(m.hrMax) }); }
      if (m.altitudeM !== null && m.altitudeM !== undefined || m.speedKmh !== null && m.speedKmh !== undefined) {
        profile.push({ t: t, altitudeM: num(m.altitudeM), speedKmh: num(m.speedKmh) });
      }
    });
    return { hr: hr, profile: profile, hasWatchRoute: profile.length > 0 };
  }

  function photoState(photos, base) {
    return photos.map(function (p) {
      return { ID: p.ID, src: base + "TripPhotos(" + p.ID + ")/thumbnail", time: hhmm(p.takenAt), fileName: p.fileName };
    });
  }

  /** The model's photos and map spots without the deleted photo; the start and end spots stay. */
  function withoutPhoto(data, id) {
    return {
      photos: data.photos.filter(function (p) { return p.ID !== id; }),
      spots: data.spots.filter(function (s) { return s.photoID !== id; })
    };
  }

  function tripIdFromContext(oContext) {
    var m = /\(([^)]+)\)$/.exec(oContext.getPath()); // /Trips(<uuid>)
    return m ? m[1].replace(/^ID=/, "").replace(/'/g, "") : null;
  }

  function checked(response) {
    if (!response.ok) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        throw new Error((body.error && body.error.message) || (response.status + " " + response.statusText));
      });
    }
    return response.status === 204 ? null : response.json(); // 204: an action without a result
  }

  var ObjectPageExt = ControllerExtension.extend("tripsui.ext.controller.ObjectPageExt", {
    override: {
      onInit: function () {
        var oBundle = this.base.getAppComponent().getModel("i18n").getResourceBundle();
        this._texts = {};
        ["start", "end", "positionFromOwnTracks", "chartTime", "chartHrAvg", "chartHrMax", "chartAltitude", "chartSpeed"].forEach(function (k) {
          this._texts[k] = oBundle.getText(k);
        }, this);
        this.base.getView().setModel(new JSONModel(emptyState(this._texts)), "trip");
        var size = storedSize();
        this._mapSize = new JSONModel({ size: size, height: mapHeight(size, window.innerHeight) });
        this.base.getView().setModel(this._mapSize, "mapSize");
        Device.resize.attachHandler(this._onWindowResize, this);
      },
      onExit: function () {
        Device.resize.detachHandler(this._onWindowResize, this);
      },
      routing: {
        onAfterBinding: function (oContext) {
          var oView = this.base.getView();
          var oModel = oView.getModel("trip");
          oModel.setData(emptyState(this._texts)); // reset first: no stale map from the previous trip
          var that = this, iReq = this._iReq = (this._iReq || 0) + 1;
          if (!oContext) { oModel.setProperty("/loading", false); return; }
          var sId = tripIdFromContext(oContext);
          var sBase = oView.getModel().getServiceUrl(); // "/trips/"
          var texts = this._texts;
          var sTrip = sBase + "Trips(" + sId + ")";

          var pTrip = fetch(sTrip + "?$select=routeWkt&$expand=workouts($select=workout_ID),photos($select=ID,takenAt,fileName,lat,lon,positionSource;$orderby=takenAt)").then(checked);
          var pMinutes = fetch(sTrip + "/minutes?$select=workout_ID,minuteTS,hrAvg,hrMax,altitudeM,speedKmh&$orderby=minuteTS&$top=" + MAX_MINUTES).then(checked);

          Promise.all([pTrip, pMinutes]).then(function (r) {
            if (that._iReq !== iReq) { return; }
            var trip = r[0], minutes = r[1].value;
            var map = mapState(trip.routeWkt, trip.photos, texts);
            oModel.setData(Object.assign(oModel.getData(), map, chartState(minutes),
              { hasWorkout: trip.workouts.length > 0, photos: photoState(trip.photos, sBase), loading: false }));
            that._fitMap(map.hasRoute ? { center: map.center, zoom: map.zoom } : null);
          }).catch(function (e) {
            if (that._iReq !== iReq) { return; }
            oModel.setData(Object.assign(oModel.getData(), { loading: false, error: String(e && e.message || e) }));
          });
        }
      }
    },

    /**
     * GeoMap keeps its own position when it re-renders after being hidden, so the bound centre
     * and zoom of the next trip are lost; apply them again after every render.
     */
    _fitMap: function (fit) {
      this._mapFit = fit;
      if (!this._map) {
        this._map = this.base.getView().findAggregatedObjects(true, function (c) { return c.isA("sap.ui.vbm.GeoMap"); })[0];
        if (!this._map) { return; }
        this._map.addEventDelegate({ onAfterRendering: this._applyMapFit }, this);
      }
      this._applyMapFit();
    },

    _applyMapFit: function () {
      if (this._mapFit && this._map.getDomRef()) {
        this._map.setCenterPosition(this._mapFit.center);
        this._map.setZoomlevel(this._mapFit.zoom);
      }
    },

    /** Size buttons on the map: one size smaller or larger, remembered in this browser. The new height re-renders the map, which fits the route again. */
    onMapSmaller: function () { this._stepMapSize(-1); },
    onMapLarger: function () { this._stepMapSize(1); },

    _stepMapSize: function (step) {
      var size = MAP_SIZES[MAP_SIZES.indexOf(this._mapSize.getProperty("/size")) + step];
      if (!size) { return; } // already the smallest or largest; the button is disabled there
      storeSize(size);
      this._setMapSize(size);
    },

    _onWindowResize: function () {
      this._setMapSize(this._mapSize.getProperty("/size"));
    },

    _setMapSize: function (size) {
      this._mapSize.setProperty("/size", size);
      this._mapSize.setProperty("/height", mapHeight(size, window.innerHeight));
    },

    /** A chart has rendered: give it a hover tooltip (a tap on the phone) once; it stays for every later render. */
    onChartRendered: function (oEvent) {
      var oChart = oEvent.getSource();
      if (oChart.data("tooltip")) { return; }
      var oTooltip = new VizTooltip();
      oTooltip.connect(oChart.getId());
      oChart.addDependent(oTooltip);
      oChart.data("tooltip", true);
    },

    /** Photo thumbnail or map spot pressed: show the photo in a LightBox. */
    onPhotoPress: function (oEvent) {
      var oCtx = oEvent.getSource().getBindingContext("trip");
      var sPhotoID = oCtx && oCtx.getProperty("photoID") || oCtx && oCtx.getProperty("ID");
      var photo = (this.base.getView().getModel("trip").getProperty("/photos") || []).filter(function (p) { return p.ID === sPhotoID; })[0];
      if (!photo) { return; }
      if (!this._lightBox) {
        this._lightBox = new LightBox({ imageContent: [new LightBoxItem()] });
        this.base.getView().addDependent(this._lightBox);
      }
      var item = this._lightBox.getImageContent()[0];
      item.setImageSrc(photo.src);
      item.setTitle(photo.time);
      item.setSubtitle(photo.fileName || "");
      this._lightBox.open();
    },

    /** Delete button under a thumbnail: confirm, delete on the server, then drop the photo and its map spot. */
    onDeletePhoto: function (oEvent) {
      var oView = this.base.getView();
      var oModel = oView.getModel("trip");
      if (oModel.getProperty("/deleting")) { return; } // a second tap before the busy indicator shows
      var oBundle = this.base.getAppComponent().getModel("i18n").getResourceBundle();
      var photo = oEvent.getSource().getBindingContext("trip").getObject();
      var sUrl = oView.getModel().getServiceUrl() + "deletePhoto";
      var sDelete = oBundle.getText("deletePhotoAction");
      MessageBox.confirm(oBundle.getText("deletePhotoQuestion", [photo.time]), {
        title: oBundle.getText("deletePhotoTitle"),
        actions: [sDelete, MessageBox.Action.CANCEL],
        emphasizedAction: sDelete,
        onClose: function (sAction) {
          if (sAction !== sDelete) { return; }
          oModel.setProperty("/deleting", true);
          // The ID goes in a JSON body, never in the URL: see srv/lib/photo-delete.js.
          fetch(sUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ID: photo.ID }) })
            .then(checked)
            .then(function () {
              var rest = withoutPhoto(oModel.getData(), photo.ID);
              oModel.setProperty("/photos", rest.photos);
              oModel.setProperty("/spots", rest.spots);
              MessageToast.show(oBundle.getText("photoDeleted"));
            })
            .catch(function (e) { MessageBox.error(String(e && e.message || e)); })
            .finally(function () { oModel.setProperty("/deleting", false); });
        }
      });
    }
  });
  ObjectPageExt.helpers = { parseWkt: parseWkt, zoomFor: zoomFor, mapState: mapState, chartState: chartState, photoState: photoState, tripIdFromContext: tripIdFromContext, withoutPhoto: withoutPhoto, checked: checked, mapHeight: mapHeight, storedSize: storedSize };
  return ObjectPageExt;
});
