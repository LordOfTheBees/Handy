use regex::RegexBuilder;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashSet;

#[derive(Clone, Debug, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct DictionaryEntry {
    pub term: String,
    #[serde(default)]
    pub variants: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct Dictionary {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub entries: Vec<DictionaryEntry>,
}

pub fn default_dictionaries() -> Vec<Dictionary> {
    vec![Dictionary {
        id: "general".to_string(),
        name: "General".to_string(),
        enabled: true,
        entries: Vec::new(),
    }]
}

pub fn validate_dictionaries(dictionaries: &[Dictionary]) -> Result<(), String> {
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    for dictionary in dictionaries {
        if dictionary.id.is_empty()
            || dictionary.id.len() > 100
            || !dictionary
                .id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            || !ids.insert(dictionary.id.as_str())
        {
            return Err("Dictionary IDs must be unique and contain only letters, numbers, hyphens or underscores".into());
        }
        let name = dictionary.name.trim();
        if dictionary.name != name || !valid_text(name, 80) || !names.insert(name.to_lowercase()) {
            return Err("Dictionary names must be unique and contain 1–80 characters".into());
        }
        let mut terms = HashSet::new();
        let mut variants = HashSet::new();
        for entry in &dictionary.entries {
            let term = entry.term.trim();
            if entry.term != term || !valid_text(term, 100) || !terms.insert(term.to_string()) {
                return Err(format!(
                    "Invalid or duplicate term in dictionary '{}'",
                    name
                ));
            }
            for variant in &entry.variants {
                let trimmed = variant.trim();
                if variant != trimmed
                    || !valid_text(trimmed, 100)
                    || !variants.insert(trimmed.to_lowercase())
                {
                    return Err(format!(
                        "Invalid or duplicate variant in dictionary '{}'",
                        name
                    ));
                }
            }
        }
    }
    Ok(())
}

fn valid_text(value: &str, max_chars: usize) -> bool {
    !value.is_empty()
        && value == value.trim()
        && value.chars().count() <= max_chars
        && !value.chars().any(char::is_control)
}

fn is_word_character(character: char) -> bool {
    character.is_alphanumeric() || character == '_'
}

pub fn active_terms(dictionaries: &[Dictionary]) -> Vec<String> {
    let mut seen = HashSet::new();
    dictionaries
        .iter()
        .filter(|dictionary| dictionary.enabled)
        .flat_map(|dictionary| &dictionary.entries)
        .filter_map(|entry| {
            if seen.insert(entry.term.to_lowercase()) {
                Some(entry.term.clone())
            } else {
                None
            }
        })
        .collect()
}

/// Literal variants are applied once to the original model output. Longer
/// variants win at the same position; dictionary order breaks exact ties.
pub fn apply_variants(text: &str, dictionaries: &[Dictionary]) -> String {
    let mut seen = HashSet::new();
    let mut variants = Vec::new();
    for dictionary in dictionaries.iter().filter(|dictionary| dictionary.enabled) {
        for entry in &dictionary.entries {
            for variant in &entry.variants {
                if seen.insert(variant.to_lowercase()) {
                    variants.push((variant.as_str(), entry.term.as_str()));
                }
            }
        }
    }
    if variants.is_empty() {
        return text.to_string();
    }
    variants.sort_by(|a, b| b.0.chars().count().cmp(&a.0.chars().count()));
    let pattern = variants
        .iter()
        .map(|(variant, _)| format!("({})", regex::escape(variant)))
        .collect::<Vec<_>>()
        .join("|");
    let Ok(regex) = RegexBuilder::new(&pattern).case_insensitive(true).build() else {
        return text.to_string();
    };

    let mut output = String::with_capacity(text.len());
    let mut last = 0;
    for captures in regex.captures_iter(text) {
        let matched = captures.get(0).expect("regex capture has a full match");
        let starts_inside_word = text[..matched.start()]
            .chars()
            .next_back()
            .is_some_and(is_word_character)
            && matched
                .as_str()
                .chars()
                .next()
                .is_some_and(is_word_character);
        let ends_inside_word = text[matched.end()..]
            .chars()
            .next()
            .is_some_and(is_word_character)
            && matched
                .as_str()
                .chars()
                .next_back()
                .is_some_and(is_word_character);
        if starts_inside_word || ends_inside_word {
            continue;
        }
        output.push_str(&text[last..matched.start()]);
        let index = (1..=variants.len())
            .find(|index| captures.get(*index).is_some())
            .expect("one variant matched");
        output.push_str(variants[index - 1].1);
        last = matched.end();
    }
    output.push_str(&text[last..]);
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dictionary(id: &str, enabled: bool, term: &str, variant: &str) -> Dictionary {
        Dictionary {
            id: id.into(),
            name: id.into(),
            enabled,
            entries: vec![DictionaryEntry {
                term: term.into(),
                variants: vec![variant.into()],
            }],
        }
    }

    #[test]
    fn active_terms_follow_dictionary_order_and_deduplicate() {
        let dictionaries = vec![
            dictionary("a", true, "Handy", "handi"),
            dictionary("b", false, "Hidden", "hidden"),
            dictionary("c", true, "handy", "hendy"),
        ];
        assert_eq!(active_terms(&dictionaries), vec!["Handy"]);
    }

    #[test]
    fn variants_replace_whole_phrases_without_losing_punctuation() {
        let dictionaries = vec![
            dictionary("ru", true, "Obsidian", "обсидиан"),
            dictionary("en", true, "Handy", "handi"),
        ];
        assert_eq!(
            apply_variants("(Обсидиан), HANDI! handiwork", &dictionaries),
            "(Obsidian), Handy! handiwork"
        );
    }

    #[test]
    fn disabled_dictionaries_do_not_replace_and_first_conflict_wins() {
        let dictionaries = vec![
            dictionary("a", true, "Claude", "cloud"),
            dictionary("b", true, "Cloud", "CLOUD"),
            dictionary("c", false, "Other", "test"),
        ];
        assert_eq!(apply_variants("cloud test", &dictionaries), "Claude test");
    }

    #[test]
    fn validation_rejects_duplicate_terms_and_variants() {
        let mut dictionaries = vec![dictionary("a", true, "Handy", "handi")];
        dictionaries[0].entries.push(DictionaryEntry {
            term: "Handy".into(),
            variants: Vec::new(),
        });
        assert!(validate_dictionaries(&dictionaries).is_err());
        dictionaries[0].entries[1].term = "Other".into();
        dictionaries[0].entries[1].variants.push("HANDI".into());
        assert!(validate_dictionaries(&dictionaries).is_err());
    }
}
