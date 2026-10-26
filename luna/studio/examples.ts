// Example Luna programs bundled into Studio via Vite's ?raw imports.
import hello from './examples/hello.luna?raw';
import counter from './examples/counter.luna?raw';
import todo from './examples/todo.luna?raw';
import landing from './examples/landing.luna?raw';

export interface LunaExample {
  id: string;
  name: string;
  description: string;
  source: string;
}

export const EXAMPLES: LunaExample[] = [
  { id: 'hello', name: 'Hello', description: 'Smallest possible Luna page', source: hello },
  { id: 'counter', name: 'Counter', description: 'State + click events', source: counter },
  { id: 'todo', name: 'Todo List', description: 'Components, lists, inputs', source: todo },
  { id: 'landing', name: 'Landing Page', description: 'Bigger styled page', source: landing },
];

export const DEFAULT_SOURCE = EXAMPLES[0].source;
