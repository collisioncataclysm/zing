import $ from "jquery";
import { InputBinding } from "./inputBinding";
import { $escape, hasOwnProperty, updateLabel } from "../../utils";
import { indirectEval } from "../../utils/eval";

type SelectHTMLElement = HTMLSelectElement & { nonempty: boolean };

type SelectInputReceiveMessageData = {
  label: string;
  options?: string;
  config?: string;
  url?: string;
  value?: string;
};

type SelectizeOptions = Selectize.IOptions<string, unknown>;
type SelectizeInfo = Selectize.IApi<string, unknown> & {
  settings: SelectizeOptions;
};

function getLabelNode(el: SelectHTMLElement): JQuery<HTMLElement> {
  let escapedId = $escape(el.id);

  if (isSelectize(el)) {
    escapedId += "-selectized";
  }
  return $(el)
    .parent()
    .parent()
    .find('label[for="' + escapedId + '"]');
}
// Return true if it's a selectize input, false if it's a regular select input.
// eslint-disable-next-line camelcase
function isSelectize(el: HTMLElement): boolean {
  const config = $(el)
    .parent()
    .find('script[data-for="' + $escape(el.id) + '"]');

  return config.length > 0;
}

class SelectInputBinding extends InputBinding {
  find(scope: HTMLElement): JQuery<HTMLElement> {
    return $(scope).find("select");
  }
  getType(el: HTMLElement): string | false {
    const $el = $(el);

    if (!$el.hasClass("symbol")) {
      // default character type
      return false;
    }
    if ($el.attr("multiple") === "multiple") {
      return "shiny.symbolList";
    } else {
      return "shiny.symbol";
    }
  }
  getId(el: SelectHTMLElement): string {
    return InputBinding.prototype.getId.call(this, el) || el.name;
  }
  getValue(el: HTMLElement): string[] | number | string | undefined {
    return $(el).val();
  }
  setValue(el: SelectHTMLElement, value: string): void {
    if (!isSelectize(el)) {
      $(el).val(value);
    } else {
      const selectize = this._selectize(el);

      if (selectize) {
        selectize.setValue(value);
      }
    }
  }
  getState(el: SelectHTMLElement): {
    label: JQuery<HTMLElement>;
    value: ReturnType<SelectInputBinding["getValue"]>;
    options: Array<{ value: string; label: string }>;
  } {
    // Store options in an array of objects, each with with value and label
    const options: Array<{ value: string; label: string }> = new Array(
      el.length
    );

    for (let i = 0; i < el.length; i++) {
      options[i] = {
        // TODO-barret; Is this a safe assumption?; Are there no Option Groups?
        value: (el[i] as HTMLOptionElement).value,
        label: el[i].label,
      };
    }

    return {
      label: getLabelNode(el),
      value: this.getValue(el),
      options: options,
    };
  }
  receiveMessage(
    el: SelectHTMLElement,
    data: SelectInputReceiveMessageData
  ): void {
    const $el = $(el);
    let selectize: SelectizeInfo | undefined;

    // This will replace all the options
    if (hasOwnProperty(data, "options")) {
      selectize = this._selectize(el);
      // Must destroy selectize before appending new options, otherwise
      // selectize will restore the original select
      if (selectize) selectize.destroy();
      // Clear existing options and add each new one
      $el.empty().append(data.options as NonNullable<typeof data.options>);
      this._selectize(el);
    }

    // re-initialize selectize
    if (hasOwnProperty(data, "config")) {
      $el
        .parent()
        .find('script[data-for="' + $escape(el.id) + '"]')
        .replaceWith(data.config as NonNullable<typeof data.config>);
      this._selectize(el, true);
    }

    // use server-side processing for selectize
    if (hasOwnProperty(data, "url")) {
      selectize = this._selectize(el) as SelectizeInfo;
      selectize.clearOptions();
      let loaded = false;

      type CallbackFn = Parameters<
        NonNullable<SelectizeInfo["settings"]["load"]>
      >[1];
      const innerSelectize = selectize as SelectizeInfo & {
        settings: {
          load: (query: string, callback: CallbackFn) => any;
        };
      };

      innerSelectize.settings.load = function (
        query: string,
        callback: CallbackFn
      ) {
        const settings = innerSelectize.settings;

        $.ajax({
          url: data.url,
          data: {
            query: query,
            field: JSON.stringify([settings.searchField]),
            value: settings.valueField,
            conju: settings.searchConjunction,
            maxop: settings.maxOptions,
          },
          type: "GET",
          error: function () {
            callback();
          },
          success: function (res) {
            // res = [{label: '1', value: '1', group: '1'}, ...]
            // success is called after options are added, but
            // groups need to be added manually below
            $.each(res, function (index, elem) {
              // Call selectize.addOptionGroup once for each optgroup; the
              // first argument is the group ID, the second is an object with
              // the group's label and value. We use the current settings of
              // the selectize object to decide the fieldnames of that obj.
              const optgroupId = elem[settings.optgroupField || "optgroup"];
              const optgroup: { [key: string]: string } = {};

              optgroup[settings.optgroupLabelField || "label"] = optgroupId;
              optgroup[settings.optgroupValueField || "value"] = optgroupId;
              innerSelectize.addOptionGroup(optgroupId, optgroup);
            });
            callback(res);
            if (!loaded) {
              if (hasOwnProperty(data, "value")) {
                if (typeof data.value === "string") {
                  innerSelectize.setValue(data.value);
                }
              } else if (settings.maxItems === 1) {
                // first item selected by default only for single-select
                innerSelectize.setValue(res[0].value);
              }
            }
            loaded = true;
          },
        });
      };
      // perform an empty search after changing the `load` function
      innerSelectize.load(function (callback) {
        innerSelectize.settings.load.apply(innerSelectize, ["", callback]);
      });
    } else if (hasOwnProperty(data, "value")) {
      this.setValue(el, data.value as string);
    }

    updateLabel(data.label, getLabelNode(el));

    $(el).trigger("change");
  }
  subscribe(el: SelectHTMLElement, callback: (x: boolean) => void): void {
    $(el).on(
      "change.selectInputBinding",
      // event: Event
      () => {
        // https://github.com/rstudio/shiny/issues/2162
        // Prevent spurious events that are gonna be squelched in
        // a second anyway by the onItemRemove down below
        if (el.nonempty && this.getValue(el) === "") {
          return;
        }
        callback(false);
      }
    );
  }
  unsubscribe(el: HTMLElement): void {
    $(el).off(".selectInputBinding");
  }
  initialize(el: SelectHTMLElement): void {
    this._selectize(el);
  }
  protected _selectize(
    el: SelectHTMLElement,
    update = false
  ): SelectizeInfo | undefined {
    if (!$.fn.selectize) return undefined;
    const $el = $(el);
    const config = $el
      .parent()
      .find('script[data-for="' + $escape(el.id) + '"]');

    if (config.length === 0) return undefined;

    let options: SelectizeOptions & {
      labelField: "label";
      valueField: "value";
      searchField: ["label"];
      onItemRemove?: (value: string) => void;
      onDropdownClose?: () => void;
    } = $.extend(
      {
        labelField: "label",
        valueField: "value",
        searchField: ["label"],
      },
      JSON.parse(config.html())
    );

    // selectize created from selectInput()
    if (typeof config.data("nonempty") !== "undefined") {
      el.nonempty = true;
      options = $.extend(options, {
        onItemRemove: function (this: SelectizeInfo, value: string) {
          if (this.getValue() === "")
            $("select#" + $escape(el.id))
              .empty()
              .append(
                $("<option/>", {
                  value: value,
                  selected: true,
                })
              )
              .trigger("change");
        },
        onDropdownClose:
          // $dropdown: any
          function (this: SelectizeInfo) {
            if (this.getValue() === "") {
              this.setValue($("select#" + $escape(el.id)).val() as string);
            }
          },
      });
    } else {
      el.nonempty = false;
    }
    // options that should be eval()ed
    if (config.data("eval") instanceof Array)
      $.each(config.data("eval"), function (i, x: string) {
        /*jshint evil: true*/
        // @ts-expect-error; Need to type `options` keys to know exactly which values are accessed.
        options[x] = indirectEval("(" + options[x] + ")");
      });
    let control = $el.selectize(options)[0].selectize as SelectizeInfo;
    // .selectize() does not really update settings; must destroy and rebuild

    if (update) {
      const settings = $.extend(control.settings, options);

      control.destroy();
      control = $el.selectize(settings)[0].selectize as SelectizeInfo;
    }
    return control;
  }
}

export { SelectInputBinding };
export type { SelectInputReceiveMessageData };
