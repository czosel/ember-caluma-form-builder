import Component from "@ember/component";
import { inject as service } from "@ember/service";
import layout from "../../templates/components/cfb-form-editor/question";
import { task, timeout } from "ember-concurrency";
import { ComponentQueryManager } from "ember-apollo-client";
import v4 from "uuid/v4";
import { optional } from "ember-composable-helpers/helpers/optional";
import { computed, getWithDefault } from "@ember/object";
import slugify from "ember-caluma-utils/utils/slugify";
import { A } from "@ember/array";
import validations from "ember-caluma-form-builder/validations/question";
import { all } from "rsvp";

import checkQuestionSlugQuery from "ember-caluma-form-builder/gql/queries/check-question-slug";
import formEditorQuestionQuery from "ember-caluma-form-builder/gql/queries/form-editor-question";
import addFormQuestionMutation from "ember-caluma-form-builder/gql/mutations/add-form-question";

import saveOptionMutation from "ember-caluma-form-builder/gql/mutations/save-option";
import saveTextQuestionMutation from "ember-caluma-form-builder/gql/mutations/save-text-question";
import saveTextareaQuestionMutation from "ember-caluma-form-builder/gql/mutations/save-textarea-question";
import saveIntegerQuestionMutation from "ember-caluma-form-builder/gql/mutations/save-integer-question";
import saveFloatQuestionMutation from "ember-caluma-form-builder/gql/mutations/save-float-question";
import saveCheckboxQuestionMutation from "ember-caluma-form-builder/gql/mutations/save-checkbox-question";
import saveRadioQuestionMutation from "ember-caluma-form-builder/gql/mutations/save-radio-question";

export const TYPES = {
  TextQuestion: saveTextQuestionMutation,
  TextareaQuestion: saveTextareaQuestionMutation,
  IntegerQuestion: saveIntegerQuestionMutation,
  FloatQuestion: saveFloatQuestionMutation,
  CheckboxQuestion: saveCheckboxQuestionMutation,
  RadioQuestion: saveRadioQuestionMutation
};

export default Component.extend(ComponentQueryManager, {
  layout,
  validations,

  notification: service(),
  intl: service(),

  possibleTypes: computed(function() {
    return Object.keys(TYPES).map(value => ({
      value,
      label: this.intl.t(`caluma.form-builder.question.types.${value}`)
    }));
  }),

  didReceiveAttrs() {
    this._super(...arguments);

    this.get("data").perform();
  },

  data: task(function*() {
    if (!this.get("slug")) {
      return A([
        {
          node: {
            label: "",
            slug: "",
            description: "",
            isRequired: "false",
            isHidden: "false",
            integerMinValue: null,
            integerMaxValue: null,
            floatMinValue: null,
            floatMaxValue: null,
            maxLength: null,
            options: [],
            __typename: Object.keys(TYPES)[0]
          }
        }
      ]);
    }

    return yield this.get("apollo").watchQuery(
      {
        query: formEditorQuestionQuery,
        variables: { slug: this.get("slug") },
        fetchPolicy: "cache-and-network"
      },
      "allQuestions.edges"
    );
  }).restartable(),

  _getIntegerQuestionInput(changeset) {
    return {
      minValue: parseInt(changeset.get("integerMinValue")),
      maxValue: parseInt(changeset.get("integerMaxValue"))
    };
  },

  _getFloatQuestionInput(changeset) {
    return {
      minValue: parseFloat(changeset.get("floatMinValue")),
      maxValue: parseFloat(changeset.get("floatMaxValue"))
    };
  },

  _getTextQuestionInput(changeset) {
    return {
      maxLength: parseInt(changeset.get("maxLength"))
    };
  },

  _getTextareaQuestionInput(changeset) {
    return {
      maxLength: parseInt(changeset.get("maxLength"))
    };
  },

  _getCheckboxQuestionInput(changeset) {
    return {
      options: changeset.get("options.edges").map(({ node: { slug } }) => slug)
    };
  },

  _getRadioQuestionInput(changeset) {
    return {
      options: changeset.get("options.edges").map(({ node: { slug } }) => slug)
    };
  },

  saveOptions: task(function*(changeset) {
    yield all(
      getWithDefault(changeset, "options.edges", []).map(
        async ({ node: option }) => {
          let { label, slug } = option;

          await this.get("apollo").mutate({
            mutation: saveOptionMutation,
            variables: { input: { label, slug } }
          });
        }
      )
    );
  }),

  submit: task(function*(changeset) {
    try {
      yield this.saveOptions.perform(changeset);

      const question = yield this.get("apollo").mutate(
        {
          mutation: TYPES[changeset.get("__typename")],
          variables: {
            input: Object.assign(
              {
                label: changeset.get("label"),
                slug: changeset.get("slug"),
                isRequired: changeset.get("isRequired"),
                isHidden: "false", // TODO: this must be configurable
                clientMutationId: v4()
              },
              this[`_get${changeset.get("__typename")}Input`](changeset)
            )
          }
        },
        `save${changeset.get("__typename")}.question`
      );

      if (!this.get("slug")) {
        // This is a new question which must be added to the form after creating it
        yield this.get("apollo").mutate({
          mutation: addFormQuestionMutation,
          variables: {
            input: {
              question: question.slug,
              form: this.get("form"),
              clientMutationId: v4()
            },
            search: ""
          }
        });
      }

      this.get("notification").success(
        this.get("intl").t(
          "caluma.form-builder.notification.question.save.success"
        )
      );

      optional([this.get("on-after-submit")])(question);
    } catch (e) {
      this.get("notification").danger(
        this.get("intl").t(
          "caluma.form-builder.notification.question.save.error"
        )
      );
    }
  }).drop(),

  validateSlug: task(function*(slug, changeset) {
    yield timeout(500);

    const res = yield this.get("apollo").query(
      {
        query: checkQuestionSlugQuery,
        variables: { slug }
      },
      "allQuestions.edges"
    );

    if (res && res.length) {
      changeset.pushErrors(
        "slug",
        this.get("intl").t("caluma.form-builder.validations.question.slug")
      );
    }
  }).restartable(),

  actions: {
    updateLabel(value, changeset) {
      changeset.set("label", value);

      if (!this.get("slug")) {
        const slug = slugify(value);
        changeset.set("slug", slug);
        this.get("validateSlug").perform(slug, changeset);
      }
    },

    updateSlug(value, changeset) {
      changeset.set("slug", value);

      this.get("validateSlug").perform(value, changeset);
    }
  }
});
