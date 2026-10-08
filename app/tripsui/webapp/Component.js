sap.ui.define(["sap/fe/core/AppComponent", "sap/ui/model/odata/type/Unit"], function (Component, Unit) {
  "use strict";

  // Fiori elements pads every unit number in a table with figure spaces to 3 decimals (its
  // decimal-alignment feature for currencies; the manifest can raise but not disable it), which
  // shows as a gap between "38,628" and "m". Trim the padding so number and unit sit together.
  const formatValue = Unit.prototype.formatValue;
  Unit.prototype.formatValue = function () {
    const v = formatValue.apply(this, arguments);
    return typeof v === "string" ? v.replace(/[\u2007\u2008]+$/, "") : v;
  };

  return Component.extend("tripsui.Component", {
    metadata: { manifest: "json" }
  });
});
