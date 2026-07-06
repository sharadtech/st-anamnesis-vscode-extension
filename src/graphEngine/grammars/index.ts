import { globalExtractorRegistry } from '../Extractor';
import { typeScriptExtractor, tsxExtractor } from './TypeScript';
import { javaScriptExtractor } from './JavaScript';
import { javaExtractor } from './Java';
import { htmlExtractor } from './Html';
import { apacheConfExtractor } from '../extractors/ApacheConf';
import { nginxConfExtractor } from '../extractors/NginxConf';
import { markdownArchExtractor } from '../extractors/MarkdownArch';
import { bashExtractor } from '../extractors/Bash';
import { jenkinsExtractor } from '../extractors/Jenkins';
import { mavenExtractor } from '../extractors/Maven';
import { htlExtractor } from '../extractors/Htl';
import { aemContentXmlExtractor } from '../extractors/AemContentXml';

globalExtractorRegistry.register(
  typeScriptExtractor,
  tsxExtractor,
  javaScriptExtractor,
  javaExtractor,
  htmlExtractor,
  apacheConfExtractor,
  nginxConfExtractor,
  markdownArchExtractor,
  bashExtractor,
  jenkinsExtractor,
  mavenExtractor,
  htlExtractor,
  aemContentXmlExtractor
);
